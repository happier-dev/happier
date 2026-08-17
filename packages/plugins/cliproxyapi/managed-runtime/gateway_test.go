package managedruntime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestValidateConfigRejectsCompetingAuthEntriesAndUnsafeServingInputs(t *testing.T) {
	t.Parallel()

	valid := Config{
		Host:             "127.0.0.1",
		Port:             32123,
		DownstreamBearer: "session-secret",
		RuntimeDir:       t.TempDir(),
		AuthEntries: []AuthEntry{
			testAuthEntry("codex", ProviderCodex, "openai-upstream"),
			testAuthEntry("claude", ProviderClaude, "anthropic-upstream"),
		},
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses, ProtocolAnthropic},
	}

	testCases := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "non-loopback host", mutate: func(cfg *Config) { cfg.Host = "0.0.0.0" }},
		{name: "zero port", mutate: func(cfg *Config) { cfg.Port = 0 }},
		{name: "missing downstream bearer", mutate: func(cfg *Config) { cfg.DownstreamBearer = "" }},
		{name: "missing runtime directory", mutate: func(cfg *Config) { cfg.RuntimeDir = "" }},
		{name: "missing purpose", mutate: func(cfg *Config) { cfg.AuthEntries[0].Purpose.Purpose = "" }},
		{name: "purpose surrounding whitespace", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Purpose = " openai-upstream "
		}},
		{name: "consumer plugin id needs owner namespace", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Consumer.PluginID = "single"
		}},
		{name: "consumer plugin id invalid segment", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Consumer.PluginID = "owner.-bad"
		}},
		{name: "consumer plugin id reserved segment", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Consumer.PluginID = "owner.constructor"
		}},
		{name: "consumer plugin id surrounding whitespace", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Consumer.PluginID = " happier.provider.cliproxyapi "
		}},
		{name: "consumer local id surrounding whitespace", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].Purpose.Consumer.LocalID = " cliproxyapi "
		}},
		{name: "unsupported provider", mutate: func(cfg *Config) { cfg.AuthEntries[0].Provider = Provider("gemini") }},
		{name: "duplicate auth id", mutate: func(cfg *Config) { cfg.AuthEntries[1].ID = cfg.AuthEntries[0].ID }},
		{name: "second codex selector entry", mutate: func(cfg *Config) {
			cfg.AuthEntries = append(cfg.AuthEntries, testAuthEntry(
				"codex-backup", ProviderCodex, "openai-backup",
			))
		}},
		{name: "second claude selector entry", mutate: func(cfg *Config) {
			cfg.AuthEntries = append(cfg.AuthEntries, testAuthEntry(
				"claude-backup", ProviderClaude, "anthropic-backup",
			))
		}},
		{name: "missing allowed HTTPS origin", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].AllowedHTTPSOrigin = ""
		}},
		{name: "non-HTTPS allowed origin", mutate: func(cfg *Config) {
			cfg.AuthEntries[0].AllowedHTTPSOrigin = "http://upstream.invalid"
		}},
		{name: "duplicate protocol", mutate: func(cfg *Config) {
			cfg.Protocols = append(cfg.Protocols, ProtocolOpenAIResponses)
		}},
		{name: "unsupported protocol", mutate: func(cfg *Config) {
			cfg.Protocols = append(cfg.Protocols, ProviderProtocol("ollama"))
		}},
	}

	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := valid
			cfg.AuthEntries = append([]AuthEntry(nil), valid.AuthEntries...)
			cfg.Protocols = append([]ProviderProtocol(nil), valid.Protocols...)
			tc.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("Validate() error = nil, want fail-closed error")
			}
		})
	}
}

func TestServingRoutesAreTypedAndExcludeManagementIdentityAndUnusedSurfaces(t *testing.T) {
	t.Parallel()

	routes, err := ServingRoutes([]Surface{
		SurfaceOpenAIResponses,
		SurfaceOpenAIResponsesWebSocket,
		SurfaceAnthropicMessages,
		SurfaceModelList,
	})
	if err != nil {
		t.Fatalf("ServingRoutes() error = %v", err)
	}
	assertRoute := func(method, path string, want bool) {
		t.Helper()
		_, got := routes[Route{Method: method, Path: path}]
		if got != want {
			t.Fatalf("route %s %s present = %t, want %t", method, path, got, want)
		}
	}

	assertRoute(http.MethodGet, "/healthz", true)
	assertRoute(http.MethodPost, "/v1/responses", true)
	assertRoute(http.MethodGet, "/v1/responses", true)
	assertRoute(http.MethodPost, "/v1/messages", true)
	assertRoute(http.MethodGet, "/v1/models", true)
	assertRoute(http.MethodPost, "/v1/chat/completions", false)
	assertRoute(http.MethodGet, "/management.html", false)
	assertRoute(http.MethodGet, "/v0/management/config", false)
	assertRoute(http.MethodGet, "/codex/callback", false)
	assertRoute(http.MethodGet, "/", false)
}

func TestProviderProtocolsAreTheSingleStrictRouteMappingOwner(t *testing.T) {
	t.Parallel()

	routes, err := ServingRoutesForProtocols([]ProviderProtocol{
		ProtocolOpenAIResponses,
		ProtocolAnthropic,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []Route{
		{Method: http.MethodPost, Path: "/v1/responses"},
		{Method: http.MethodGet, Path: "/v1/responses"},
		{Method: http.MethodPost, Path: "/v1/messages"},
		{Method: http.MethodPost, Path: "/v1/messages/count_tokens"},
		{Method: http.MethodGet, Path: "/healthz"},
	} {
		if _, ok := routes[route]; !ok {
			t.Fatalf("protocol route missing: %#v", route)
		}
	}
	if _, ok := routes[Route{Method: http.MethodPost, Path: "/v1/chat/completions"}]; ok {
		t.Fatal("unconfigured openai-chat route was exposed")
	}
	if _, ok := routes[Route{Method: http.MethodGet, Path: "/v1/models"}]; ok {
		t.Fatal("session protocol mapping exposed the catalog-only model-list route")
	}
}

func TestStrictServingMiddlewareBlocksEveryUnconfiguredRouteBeforeHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	routes, err := ServingRoutes([]Surface{SurfaceOpenAIResponses})
	if err != nil {
		t.Fatalf("ServingRoutes() error = %v", err)
	}
	engine := gin.New()
	engine.Use(StrictServingMiddleware(routes))

	handlerCalls := 0
	engine.POST("/v1/responses", func(c *gin.Context) {
		handlerCalls++
		c.Status(http.StatusNoContent)
	})
	engine.GET("/v0/management/config", func(c *gin.Context) {
		handlerCalls++
		c.Status(http.StatusOK)
	})

	allowed := httptest.NewRecorder()
	engine.ServeHTTP(allowed, httptest.NewRequest(http.MethodPost, "/v1/responses", nil))
	if allowed.Code != http.StatusNoContent {
		t.Fatalf("allowed status = %d, want %d", allowed.Code, http.StatusNoContent)
	}

	blocked := httptest.NewRecorder()
	engine.ServeHTTP(blocked, httptest.NewRequest(http.MethodGet, "/v0/management/config", nil))
	if blocked.Code != http.StatusNotFound {
		t.Fatalf("blocked status = %d, want %d", blocked.Code, http.StatusNotFound)
	}
	if handlerCalls != 1 {
		t.Fatalf("handler calls = %d, want only the allowed handler", handlerCalls)
	}
}

func TestLeaseTransportAcquiresPerAttemptAndOwnsCredentialHeadersAfterExecutorShaping(t *testing.T) {
	t.Parallel()

	broker := &sequenceBroker{leases: []OAuthBearerLease{
		leaseWithHeaders("lease-token-a", map[string]string{"Chatgpt-Account-Id": "account-a"}),
		validLease("lease-token-b", nil),
	}}
	capture := &captureRoundTripper{}
	provider, err := newLeaseRoundTripperProvider(
		[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
		broker,
		capture,
	)
	if err != nil {
		t.Fatalf("newLeaseRoundTripperProvider() error = %v", err)
	}
	rt := provider.RoundTripperFor(&coreauth.Auth{ID: "codex", Provider: "codex"})

	for attempt := 0; attempt < 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", strings.NewReader("{}"))
		request.Header.Set("Authorization", "Bearer registration-sentinel")
		request.Header.Set("ChatGPT-Account-ID", "stale-registration-account")
		request.Header.Set("X-Api-Key", "stale-api-key")
		request.Header.Set("X-Claude-Code-Session-Id", "stale-credential-derived-session")
		response, errRoundTrip := rt.RoundTrip(request)
		if errRoundTrip != nil {
			t.Fatalf("attempt %d RoundTrip() error = %v", attempt+1, errRoundTrip)
		}
		_ = response.Body.Close()
		if got := request.Header.Get("Authorization"); got != "Bearer registration-sentinel" {
			t.Fatalf("attempt %d caller Authorization mutated = %q", attempt+1, got)
		}
		if got := request.Header.Get("Chatgpt-Account-Id"); got != "stale-registration-account" {
			t.Fatalf("attempt %d caller account header mutated = %q", attempt+1, got)
		}
		if got := request.Header.Get("X-Claude-Code-Session-Id"); got != "stale-credential-derived-session" {
			t.Fatalf("attempt %d caller Claude session identity mutated = %q", attempt+1, got)
		}
	}

	if got := broker.purposes(); len(got) != 2 || got[0].Purpose != "openai-upstream" || got[1].Purpose != "openai-upstream" {
		t.Fatalf("broker purposes = %#v, want one lookup per independent attempt", got)
	}
	requests := capture.requests()
	if got := requests[0].Header.Get("Authorization"); got != "Bearer lease-token-a" {
		t.Fatalf("first Authorization = %q", got)
	}
	if got := requests[0].Header.Get("Chatgpt-Account-Id"); got != "account-a" {
		t.Fatalf("first Chatgpt-Account-Id = %q", got)
	}
	if got := requests[0].Header.Get("X-Api-Key"); got != "" {
		t.Fatalf("first stale X-Api-Key survived = %q", got)
	}
	if got := requests[0].Header.Get("X-Claude-Code-Session-Id"); got != "" {
		t.Fatalf("first stale X-Claude-Code-Session-Id survived = %q", got)
	}
	if got := requests[1].Header.Get("Authorization"); got != "Bearer lease-token-b" {
		t.Fatalf("second Authorization = %q", got)
	}
	if got := requests[1].Header.Get("Chatgpt-Account-Id"); got != "" {
		t.Fatalf("second stale Chatgpt-Account-Id survived = %q", got)
	}
	if got := requests[1].Header.Get("X-Api-Key"); got != "" {
		t.Fatalf("second stale X-Api-Key survived = %q", got)
	}
	if got := requests[1].Header.Get("X-Claude-Code-Session-Id"); got != "" {
		t.Fatalf("second stale X-Claude-Code-Session-Id survived = %q", got)
	}
}

func TestLeaseTransportRejectsCrossOriginRedirectBeforeSecondBrokerLookupOrUpstreamEffect(t *testing.T) {
	t.Parallel()

	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("first-lease", nil),
		validLease("must-not-be-read", nil),
	}}
	upstream := &redirectRoundTripper{location: "https://untrusted.invalid/next"}
	provider, err := newLeaseRoundTripperProvider(
		[]AuthEntry{{
			ID:                 "codex",
			Provider:           ProviderCodex,
			Purpose:            testPurpose("openai-upstream"),
			AllowedHTTPSOrigin: "https://upstream.invalid",
		}},
		broker,
		upstream,
	)
	if err != nil {
		t.Fatalf("newLeaseRoundTripperProvider() error = %v", err)
	}

	client := &http.Client{Transport: provider.RoundTripperFor(&coreauth.Auth{
		ID: "codex", Provider: string(ProviderCodex),
	})}
	response, err := client.Get("https://upstream.invalid/v1/responses")
	if response != nil {
		_ = response.Body.Close()
	}
	if err == nil {
		t.Fatal("cross-origin redirect completed, want rejection before a second request-auth lookup")
	}
	if got := len(broker.purposes()); got != 1 {
		t.Fatalf("request-auth lookups = %d, want 1", got)
	}
	if got := len(upstream.requests()); got != 1 {
		t.Fatalf("upstream effects = %d, want 1", got)
	}
}

func TestLeaseTransportReauthorizesSameOriginRedirectAtTheFinalTransport(t *testing.T) {
	t.Parallel()

	broker := &sequenceBroker{leases: []OAuthBearerLease{
		validLease("first-lease", nil),
		validLease("second-lease", nil),
	}}
	upstream := &redirectRoundTripper{location: "https://upstream.invalid/v1/redirected"}
	provider, err := newLeaseRoundTripperProvider(
		[]AuthEntry{{
			ID:                 "codex",
			Provider:           ProviderCodex,
			Purpose:            testPurpose("openai-upstream"),
			AllowedHTTPSOrigin: "https://upstream.invalid",
		}},
		broker,
		upstream,
	)
	if err != nil {
		t.Fatalf("newLeaseRoundTripperProvider() error = %v", err)
	}

	client := &http.Client{Transport: provider.RoundTripperFor(&coreauth.Auth{
		ID: "codex", Provider: string(ProviderCodex),
	})}
	response, err := client.Get("https://upstream.invalid/v1/responses")
	if err != nil {
		t.Fatalf("same-origin redirect failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("same-origin redirected status = %d, want 200", response.StatusCode)
	}
	if got := len(broker.purposes()); got != 2 {
		t.Fatalf("request-auth lookups = %d, want 2", got)
	}
	requests := upstream.requests()
	if len(requests) != 2 {
		t.Fatalf("upstream effects = %d, want 2", len(requests))
	}
	if got := requests[1].Header.Get("Authorization"); got != "Bearer second-lease" {
		t.Fatalf("same-origin redirect authorization = %q, want current second lease", got)
	}
}

func TestLeaseTransportRejectsInvalidAuthoritativeHeaderProjectionWithoutUpstreamEffect(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name  string
		lease OAuthBearerLease
	}{
		{
			name:  "authorization in required headers",
			lease: leaseWithHeaders("lease-token", map[string]string{"authorization": "not-allowed"}),
		},
		{
			name: "case-insensitive duplicate",
			lease: leaseWithHeaders("lease-token", map[string]string{
				"Chatgpt-Account-Id": "a",
				"chatgpt-account-id": "b",
			}),
		},
		{name: "missing access token", lease: validLease("", nil)},
		{name: "expired lease", lease: expiredLease("lease-token")},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			capture := &captureRoundTripper{}
			broker := &sequenceBroker{leases: []OAuthBearerLease{tc.lease}}
			provider, err := newLeaseRoundTripperProvider(
				[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
				broker,
				capture,
			)
			if err != nil {
				t.Fatalf("newLeaseRoundTripperProvider() error = %v", err)
			}
			request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", nil)
			_, err = provider.RoundTripperFor(&coreauth.Auth{
				ID:       "codex",
				Provider: string(ProviderCodex),
			}).RoundTrip(request)
			if err == nil {
				t.Fatal("RoundTrip() error = nil, want fail-closed lease error")
			}
			if len(broker.purposes()) != 1 {
				t.Fatal("invalid lease test did not reach the canonical request-auth lookup boundary")
			}
			if len(capture.requests()) != 0 {
				t.Fatal("invalid lease reached upstream transport")
			}
			if strings.Contains(err.Error(), "lease-token") || strings.Contains(err.Error(), "secret") {
				t.Fatalf("error leaked credential material: %v", err)
			}
		})
	}
}

func TestLeaseTransportOwnsExactlyOneBodySafeRetryAfterCurrentnessChanged(t *testing.T) {
	t.Parallel()

	for _, outcomeStatus := range []FailureStatus{
		FailureStatusCurrentChanged,
		FailureStatusStaleContext,
	} {
		t.Run(string(outcomeStatus), func(t *testing.T) {
			broker := &sequenceBroker{
				leases: []OAuthBearerLease{
					validLease("member-a", map[string]string{"Chatgpt-Account-Id": "account-a"}),
					validLease("member-b", map[string]string{"Chatgpt-Account-Id": "account-b"}),
				},
				authOutcomes: []RequestAuthFailureOutcome{{Status: outcomeStatus}},
			}
			upstream := &statusRoundTripper{statuses: []int{http.StatusUnauthorized, http.StatusOK}}
			provider, err := newLeaseRoundTripperProvider(
				[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
				broker,
				upstream,
			)
			if err != nil {
				t.Fatalf("newLeaseRoundTripperProvider() error = %v", err)
			}
			request, err := http.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			response, err := provider.RoundTripperFor(&coreauth.Auth{ID: "codex", Provider: "codex"}).RoundTrip(request)
			if err != nil {
				t.Fatalf("RoundTrip() error = %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want successful leaf retry", response.StatusCode)
			}
			if len(upstream.requests()) != 2 {
				t.Fatalf("upstream effects = %d, want exactly one retry", len(upstream.requests()))
			}
			if got := upstream.requests()[1].Header.Get("Chatgpt-Account-Id"); got != "account-b" {
				t.Fatalf("retry account header = %q", got)
			}
			if got := len(broker.authFailures); got != 1 {
				t.Fatalf("auth failure reports = %d, want 1", got)
			}
		})
	}
}

func TestLeaseTransportDoesNotReplayDeniedOrTimedOutAuthFailureReports(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name          string
		outcome       RequestAuthFailureOutcome
		reportFailure error
	}{
		{
			name:    "denied",
			outcome: RequestAuthFailureOutcome{Status: FailureStatusDenied},
		},
		{
			name:          "request-auth deadline",
			reportFailure: context.DeadlineExceeded,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			broker := &sequenceBroker{
				leases: []OAuthBearerLease{
					validLease("member-a", nil),
					validLease("must-not-be-read", nil),
				},
				authOutcomes: []RequestAuthFailureOutcome{testCase.outcome},
				authErrors:   []error{testCase.reportFailure},
			}
			upstream := &statusRoundTripper{statuses: []int{http.StatusUnauthorized, http.StatusOK}}
			provider, err := newLeaseRoundTripperProvider(
				[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
				broker,
				upstream,
			)
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			response, err := provider.RoundTripperFor(&coreauth.Auth{ID: "codex", Provider: "codex"}).RoundTrip(request)
			if err != nil {
				t.Fatalf("RoundTrip() error = %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want original 401", response.StatusCode)
			}
			if got := len(upstream.requests()); got != 1 {
				t.Fatalf("upstream effects = %d, want exactly 1", got)
			}
			if got := len(broker.purposes()); got != 1 {
				t.Fatalf("request-auth lookups = %d, want exactly 1", got)
			}
			if got := len(broker.authFailures); got != 1 {
				t.Fatalf("auth-failure reports = %d, want exactly 1", got)
			}
		})
	}
}

func TestParseRetryAfterMSRejectsOverflowingIntegerSeconds(t *testing.T) {
	t.Parallel()

	if got := parseRetryAfterMS("9223372036854775807", time.Unix(0, 0)); got != nil {
		t.Fatalf("parseRetryAfterMS() = %d, want nil for overflowing seconds", *got)
	}
}

func TestLeaseTransportNeverRetriesQuotaOrUnsafeAuthBody(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name              string
		status            int
		wantLimitCategory string
	}{
		{
			name:              "quota",
			status:            http.StatusTooManyRequests,
			wantLimitCategory: "rate_limit",
		},
		{
			name:              "capacity",
			status:            529,
			wantLimitCategory: "capacity",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("member-a", nil)}}
			upstream := &statusRoundTripper{statuses: []int{testCase.status}}
			provider, err := newLeaseRoundTripperProvider(
				[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
				broker,
				upstream,
			)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", strings.NewReader("{}"))
			response, err := provider.RoundTripperFor(&coreauth.Auth{ID: "codex", Provider: "codex"}).RoundTrip(request)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if len(upstream.requests()) != 1 || len(broker.quotaFailures) != 1 {
				t.Fatalf(
					"%s effects=%d reports=%d, want 1/1",
					testCase.name,
					len(upstream.requests()),
					len(broker.quotaFailures),
				)
			}
			if got := broker.quotaFailures[0].NormalizedFailure.Evidence.LimitCategory; got != testCase.wantLimitCategory {
				t.Fatalf(
					"%s limitCategory = %q, want %q",
					testCase.name,
					got,
					testCase.wantLimitCategory,
				)
			}
		})
	}

	t.Run("unsafe auth body", func(t *testing.T) {
		broker := &sequenceBroker{
			leases:       []OAuthBearerLease{validLease("member-a", nil)},
			authOutcomes: []RequestAuthFailureOutcome{{Status: FailureStatusCurrentChanged}},
		}
		upstream := &statusRoundTripper{statuses: []int{http.StatusUnauthorized}}
		provider, err := newLeaseRoundTripperProvider(
			[]AuthEntry{testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")},
			broker,
			upstream,
		)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", io.NopCloser(strings.NewReader("{}")))
		request.GetBody = nil
		response, err := provider.RoundTripperFor(&coreauth.Auth{ID: "codex", Provider: "codex"}).RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if len(upstream.requests()) != 1 || len(broker.authFailures) != 1 {
			t.Fatalf("unsafe auth effects=%d reports=%d, want 1/1", len(upstream.requests()), len(broker.authFailures))
		}
	})
}

func leaseWithHeaders(token string, headers map[string]string) OAuthBearerLease {
	lease := validLease(token, headers)
	return lease
}

func expiredLease(token string) OAuthBearerLease {
	lease := validLease(token, nil)
	lease.ExpiresAt = time.Now().Add(-time.Minute).UnixMilli()
	return lease
}

func TestValidateLeaseMirrorsFrozenCredentialContextBounds(t *testing.T) {
	t.Parallel()

	valid := validLease("lease-token", nil)
	testCases := []struct {
		name   string
		mutate func(*OAuthBearerLease)
	}{
		{name: "negative expiry", mutate: func(lease *OAuthBearerLease) { lease.ExpiresAt = -1 }},
		{name: "invalid service plugin id", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.Account.Service.PluginID = "single"
		}},
		{name: "invalid service local id", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.Account.Service.LocalID = "Bad"
		}},
		{name: "missing account id", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.Account.AccountID = ""
		}},
		{name: "invalid credential revision", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.CredentialRevision = "revision-1"
		}},
		{name: "invalid group id", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.Group = &RequestAuthGroupContext{GroupID: "bad/group", Generation: 1}
		}},
		{name: "negative group generation", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.Group = &RequestAuthGroupContext{GroupID: "group-a", Generation: -1}
		}},
		{name: "invalid token fingerprint", mutate: func(lease *OAuthBearerLease) {
			lease.CredentialContext.FailingAccessTokenFingerprint = "sha256:not-hex"
		}},
	}
	if err := validateLease(valid, time.Now()); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			lease := valid
			tc.mutate(&lease)
			if err := validateLease(lease, time.Now()); err == nil {
				t.Fatal("validateLease() error = nil")
			}
		})
	}
}

type sequenceBroker struct {
	mu            sync.Mutex
	leases        []OAuthBearerLease
	calls         []QualifiedPurpose
	next          int
	err           error
	authOutcomes  []RequestAuthFailureOutcome
	authErrors    []error
	authFailures  []ConnectedAccountAuthFailureRequest
	quotaFailures []ConnectedAccountQuotaFailureRequest
}

func (b *sequenceBroker) ReportAuthFailure(_ context.Context, request ConnectedAccountAuthFailureRequest) (RequestAuthFailureOutcome, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.authFailures = append(b.authFailures, request)
	index := len(b.authFailures) - 1
	if index < len(b.authErrors) && b.authErrors[index] != nil {
		return RequestAuthFailureOutcome{}, b.authErrors[index]
	}
	if index < len(b.authOutcomes) {
		return b.authOutcomes[index], nil
	}
	return RequestAuthFailureOutcome{Status: FailureStatusCurrentUnchanged}, nil
}

func (b *sequenceBroker) ReportQuotaFailure(_ context.Context, request ConnectedAccountQuotaFailureRequest) (RequestAuthFailureOutcome, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.quotaFailures = append(b.quotaFailures, request)
	return RequestAuthFailureOutcome{Status: FailureStatusCurrentUnchanged}, nil
}

func (b *sequenceBroker) LookupRequestAuth(_ context.Context, purpose QualifiedPurpose) (OAuthBearerLease, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, purpose)
	if b.err != nil {
		return OAuthBearerLease{}, b.err
	}
	if b.next >= len(b.leases) {
		return OAuthBearerLease{}, errors.New("no fixture lease")
	}
	lease := b.leases[b.next]
	b.next++
	return lease, nil
}

func (b *sequenceBroker) purposes() []QualifiedPurpose {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]QualifiedPurpose(nil), b.calls...)
}

type captureRoundTripper struct {
	mu   sync.Mutex
	seen []*http.Request
}

type statusRoundTripper struct {
	captureRoundTripper
	statuses []int
}

type redirectRoundTripper struct {
	captureRoundTripper
	location string
}

func (s *redirectRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := s.captureRoundTripper.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if len(s.requests()) == 1 {
		response.StatusCode = http.StatusFound
		response.Header.Set("Location", s.location)
	}
	return response, nil
}

func (s *statusRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := s.captureRoundTripper.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	index := len(s.requests()) - 1
	if index < len(s.statuses) {
		response.StatusCode = s.statuses[index]
	}
	return response, nil
}

func (c *captureRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.seen = append(c.seen, request.Clone(request.Context()))
	c.seen[len(c.seen)-1].Header = request.Header.Clone()
	c.mu.Unlock()
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("{}")),
		Request:    request,
	}, nil
}

func (c *captureRoundTripper) requests() []*http.Request {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*http.Request(nil), c.seen...)
}

func testPurpose(localPurpose string) QualifiedPurpose {
	return QualifiedPurpose{
		Consumer: ContributionIdentity{
			PluginID: "happier.provider.cliproxyapi",
			LocalID:  "cliproxyapi",
		},
		Purpose: localPurpose,
	}
}

func testAuthEntry(id string, provider Provider, purpose string) AuthEntry {
	allowedHTTPSOrigin := "https://upstream.invalid"
	switch provider {
	case ProviderCodex:
		allowedHTTPSOrigin = "https://chatgpt.com"
	case ProviderClaude:
		allowedHTTPSOrigin = "https://api.anthropic.com"
	}
	return AuthEntry{
		ID:                 id,
		Provider:           provider,
		Purpose:            testPurpose(purpose),
		AllowedHTTPSOrigin: allowedHTTPSOrigin,
	}
}

func testLeaseAuthEntry(id string, provider Provider, purpose string) AuthEntry {
	entry := testAuthEntry(id, provider, purpose)
	entry.AllowedHTTPSOrigin = "https://upstream.invalid"
	return entry
}
