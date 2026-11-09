package managedruntime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type QualifiedAccountRef struct {
	Service   ContributionIdentity `json:"service"`
	AccountID string               `json:"accountId"`
}

type RequestAuthGroupContext struct {
	GroupID    string `json:"groupId"`
	Generation int64  `json:"generation"`
}

type RequestAuthCredentialContext struct {
	Account                       QualifiedAccountRef      `json:"account"`
	Group                         *RequestAuthGroupContext `json:"group,omitempty"`
	CredentialRevision            string                   `json:"credentialRevision"`
	FailingAccessTokenFingerprint string                   `json:"failingAccessTokenFingerprint,omitempty"`
}

type RequestAuthHeaders struct {
	Headers           map[string]string            `json:"headers"`
	Facts             map[string]any               `json:"facts"`
	ExpiresAt         int64                        `json:"expiresAt,omitempty"`
	CredentialContext RequestAuthCredentialContext `json:"credentialContext"`
}

type RequestAuthBroker interface {
	LookupRequestAuth(ctx context.Context, purpose QualifiedPurpose) (RequestAuthHeaders, error)
	ReportAuthFailure(ctx context.Context, request ConnectedAccountAuthFailureRequest) (RequestAuthFailureOutcome, error)
	ReportQuotaFailure(ctx context.Context, request ConnectedAccountQuotaFailureRequest) (RequestAuthFailureOutcome, error)
}

type BoundedProviderFailureEvidence struct {
	HTTPStatus     *int                          `json:"httpStatus,omitempty"`
	ProviderCode   string                        `json:"providerCode,omitempty"`
	RetryAfterMS   *int64                        `json:"retryAfterMs,omitempty"`
	ResetAtMS      *int64                        `json:"resetAtMs,omitempty"`
	LimitCategory  string                        `json:"limitCategory"`
	QuotaScope     string                        `json:"quotaScope"`
	EvidenceSource ProviderFailureEvidenceSource `json:"evidenceSource"`
}

type ProviderFailureEvidenceSource struct {
	Kind string `json:"kind"`
}

type ConnectedAccountConsumerFailure struct {
	Class    string                         `json:"class"`
	Evidence BoundedProviderFailureEvidence `json:"evidence"`
}

type ConnectedAccountAuthFailureRequest struct {
	CredentialContext RequestAuthCredentialContext    `json:"credentialContext"`
	NormalizedFailure ConnectedAccountConsumerFailure `json:"normalizedFailure"`
}

type ConnectedAccountQuotaFailureRequest struct {
	CredentialContext RequestAuthCredentialContext    `json:"credentialContext"`
	NormalizedFailure ConnectedAccountConsumerFailure `json:"normalizedFailure"`
}

type FailureStatus string

const (
	FailureStatusStaleContext     FailureStatus = "stale_context"
	FailureStatusCurrentUnchanged FailureStatus = "current_unchanged"
	FailureStatusCurrentChanged   FailureStatus = "current_changed"
	FailureStatusDenied           FailureStatus = "denied"
)

type RequestAuthFailureOutcome struct {
	Status FailureStatus `json:"status"`
}

type leaseRoundTripperProvider struct {
	entries                map[string]AuthEntry
	broker                 RequestAuthBroker
	base                   http.RoundTripper
	consumerAccessRequired bool
}

func newLeaseRoundTripperProvider(
	entries []AuthEntry,
	broker RequestAuthBroker,
	base http.RoundTripper,
) (*leaseRoundTripperProvider, error) {
	if broker == nil {
		return nil, fmt.Errorf("request-auth broker is required")
	}
	if base == nil {
		base = http.DefaultTransport
	}
	byID := make(map[string]AuthEntry, len(entries))
	for _, entry := range entries {
		if entry.ID == "" {
			return nil, fmt.Errorf("auth entry id is required")
		}
		if _, exists := byID[entry.ID]; exists {
			return nil, fmt.Errorf("auth entry id %q is duplicated", entry.ID)
		}
		byID[entry.ID] = entry
	}
	return &leaseRoundTripperProvider{entries: byID, broker: broker, base: base}, nil
}

func (p *leaseRoundTripperProvider) RoundTripperFor(auth *coreauth.Auth) http.RoundTripper {
	if p == nil || auth == nil {
		return errorRoundTripper{err: fmt.Errorf("managed auth entry is missing")}
	}
	entry, ok := managedEntryForAuth(p.entries, auth)
	if !ok || strings.TrimSpace(auth.Provider) != string(entry.Provider) {
		return errorRoundTripper{err: fmt.Errorf("managed auth entry is not authorized")}
	}
	return &leaseRoundTripper{
		entry:                  entry,
		broker:                 p.broker,
		base:                   p.base,
		consumerAccessRequired: p.consumerAccessRequired,
	}
}

type leaseRoundTripper struct {
	entry                  AuthEntry
	broker                 RequestAuthBroker
	base                   http.RoundTripper
	consumerAccessRequired bool
}

func (t *leaseRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return t.roundTrip(request, true)
}

func (t *leaseRoundTripper) roundTrip(request *http.Request, allowAuthRetry bool) (*http.Response, error) {
	if request == nil {
		return nil, fmt.Errorf("upstream request is missing")
	}
	if err := requireAllowedHTTPSOrigin(request.URL, t.entry.AllowedHTTPSOrigins); err != nil {
		return nil, err
	}
	if err := t.requireAdmittedConsumer(request.Context()); err != nil {
		return nil, err
	}
	lease, err := t.broker.LookupRequestAuth(request.Context(), t.entry.Purpose)
	if err != nil {
		if request.Context().Err() != nil {
			return nil, request.Context().Err()
		}
		var refusal *BrokerHTTPError
		if !errors.As(err, &refusal) {
			refusal = &BrokerHTTPError{StatusCode: http.StatusServiceUnavailable, Code: "request_auth_unavailable"}
		}
		return refusal.providerResponse(request), nil
	}
	// Finite admitted work retains its selected scope across a credential
	// borrow. Caller cancellation still wins before the upstream effect.
	if err := request.Context().Err(); err != nil {
		return nil, err
	}

	outbound := request.Clone(request.Context())
	outbound.Header = request.Header.Clone()
	// Strip SDK-derived credential headers using the plugin's family owner,
	// including stale headers from another family on a reused request.
	for _, family := range managedFamilies {
		for _, name := range family.StripHeaderNames {
			for wireName := range outbound.Header {
				if strings.EqualFold(wireName, name) {
					delete(outbound.Header, wireName)
				}
			}
		}
	}
	for name, value := range lease.Headers {
		outbound.Header.Set(name, value)
	}
	response, err := t.base.RoundTrip(outbound)
	if err != nil || response == nil {
		return response, err
	}
	status := response.StatusCode
	switch status {
	case http.StatusUnauthorized:
		outcome, errReport := t.broker.ReportAuthFailure(request.Context(), ConnectedAccountAuthFailureRequest{
			CredentialContext: lease.CredentialContext,
			NormalizedFailure: normalizedHTTPFailure("authentication", response),
		})
		if errReport == nil &&
			(outcome.Status == FailureStatusCurrentChanged ||
				outcome.Status == FailureStatusStaleContext) &&
			allowAuthRetry && request.GetBody != nil {
			retryBody, errBody := request.GetBody()
			if errBody == nil {
				_ = response.Body.Close()
				retry := request.Clone(request.Context())
				retry.Header = request.Header.Clone()
				retry.Body = retryBody
				return t.roundTrip(retry, false)
			}
		}
	case http.StatusTooManyRequests:
		_, _ = t.broker.ReportQuotaFailure(request.Context(), ConnectedAccountQuotaFailureRequest{
			CredentialContext: lease.CredentialContext,
			NormalizedFailure: normalizedHTTPFailure("quota", response),
		})
	default:
		if status >= http.StatusInternalServerError && status <= 599 {
			_, _ = t.broker.ReportQuotaFailure(request.Context(), ConnectedAccountQuotaFailureRequest{
				CredentialContext: lease.CredentialContext,
				NormalizedFailure: normalizedHTTPFailure("quota", response),
			})
		}
	}
	return response, nil
}

func (t *leaseRoundTripper) requireAdmittedConsumer(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !t.consumerAccessRequired {
		return nil
	}
	scope, ok := requestConsumerScope(ctx)
	if !ok {
		return fmt.Errorf("consumer access is required")
	}
	if !scope.access.admits(t.entry.Purpose) {
		return fmt.Errorf("consumer purpose is not authorized")
	}
	return nil
}

func normalizedHTTPFailure(class string, response *http.Response) ConnectedAccountConsumerFailure {
	status := response.StatusCode
	limitCategory := "rate_limit"
	if class == "authentication" {
		limitCategory = "auth_invalid"
	} else if status >= http.StatusInternalServerError && status <= 599 {
		limitCategory = "capacity"
	}
	evidence := BoundedProviderFailureEvidence{
		HTTPStatus:    &status,
		LimitCategory: limitCategory,
		// HTTP status alone does not identify a provider-owned quota subject.
		QuotaScope: "unknown",
		EvidenceSource: ProviderFailureEvidenceSource{
			Kind: "structured",
		},
	}
	if retryAfter := parseRetryAfterMS(response.Header.Get("Retry-After"), time.Now()); retryAfter != nil {
		evidence.RetryAfterMS = retryAfter
	}
	return ConnectedAccountConsumerFailure{Class: class, Evidence: evidence}
}

func parseRetryAfterMS(value string, now time.Time) *int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		const max = int64(7 * 24 * time.Hour / time.Millisecond)
		if seconds > max/1000 {
			return nil
		}
		ms := seconds * 1000
		return &ms
	}
	if date, err := http.ParseTime(value); err == nil {
		ms := date.Sub(now).Milliseconds()
		if ms < 0 {
			ms = 0
		}
		const max = int64(7 * 24 * time.Hour / time.Millisecond)
		if ms <= max {
			return &ms
		}
	}
	return nil
}

type errorRoundTripper struct {
	err error
}

func (t errorRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, t.err
}

var (
	headerNamePattern         = regexp.MustCompile(`^[!#$%&'*+\-.^_` + "`" + `|~0-9A-Za-z]+$`)
	groupIDPattern            = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)
	credentialRevisionPattern = regexp.MustCompile(`^csr_[A-Za-z0-9_-]{22,64}$`)
	tokenFingerprintPattern   = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func validateRequestAuthHeaders(lease RequestAuthHeaders, now time.Time) error {
	if lease.Headers == nil {
		return fmt.Errorf("request-auth headers are missing")
	}
	if lease.Facts == nil {
		return fmt.Errorf("request-auth facts are missing")
	}
	for _, value := range lease.Facts {
		switch value.(type) {
		case string, bool, float64:
		default:
			return fmt.Errorf("request-auth fact must be scalar")
		}
	}
	if lease.ExpiresAt < 0 {
		return fmt.Errorf("request-auth lease expiry is invalid")
	}
	if lease.ExpiresAt > 0 && now.UnixMilli() >= lease.ExpiresAt {
		return fmt.Errorf("request-auth lease is expired")
	}
	if len(lease.Headers) > 32 {
		return fmt.Errorf("request-auth lease has too many required headers")
	}
	seen := make(map[string]struct{}, len(lease.Headers))
	for name, value := range lease.Headers {
		normalized := strings.ToLower(name)
		if _, exists := seen[normalized]; exists {
			return fmt.Errorf("request-auth lease required header names must be unique case-insensitively")
		}
		seen[normalized] = struct{}{}
		if len(name) == 0 || len(name) > 128 || !headerNamePattern.MatchString(name) {
			return fmt.Errorf("request-auth lease contains an invalid required header name")
		}
		maxValueBytes := 16 * 1024
		if normalized == "authorization" {
			// Preserve the former token bound plus its Bearer scheme prefix.
			maxValueBytes = 128*1024 + len("Bearer ")
		}
		if len(value) > maxValueBytes || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("request-auth lease contains an invalid required header value")
		}
	}
	context := lease.CredentialContext
	if err := context.Account.Service.validate(); err != nil {
		return fmt.Errorf("request-auth lease account service is invalid")
	}
	accountID := strings.TrimSpace(context.Account.AccountID)
	if context.Account.AccountID != accountID || accountID == "" || len(accountID) > 256 {
		return fmt.Errorf("request-auth lease account id is invalid")
	}
	if !credentialRevisionPattern.MatchString(context.CredentialRevision) {
		return fmt.Errorf("request-auth lease credential revision is invalid")
	}
	if context.Group != nil {
		groupID := strings.TrimSpace(context.Group.GroupID)
		if context.Group.GroupID != groupID || !groupIDPattern.MatchString(groupID) ||
			context.Group.Generation < 0 {
			return fmt.Errorf("request-auth lease group context is invalid")
		}
	}
	if fingerprint := context.FailingAccessTokenFingerprint; fingerprint != "" &&
		!tokenFingerprintPattern.MatchString(fingerprint) {
		return fmt.Errorf("request-auth lease token fingerprint is invalid")
	}
	return nil
}
