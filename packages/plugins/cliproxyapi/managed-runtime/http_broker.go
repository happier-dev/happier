package managedruntime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	ConnectedAccountRequestAuthLookupPath       = "/connected-accounts/request-auth/lookup"
	ConnectedAccountRequestAuthFailurePath      = "/connected-accounts/request-auth/auth-failure"
	ConnectedAccountRequestAuthQuotaFailurePath = "/connected-accounts/request-auth/quota-failure"
	ConnectedAccountCapabilityHeader            = "x-happier-connected-account-capability"
	requestAuthBrokerTransportTimeout           = 30 * time.Second
)

type HTTPBrokerConfig struct {
	CapabilityPath string `json:"capabilityPath"`
}

type HTTPBroker struct {
	config HTTPBrokerConfig
	client *http.Client
}

type requestAuthTransportTuple struct {
	materializationID  string
	subjectScopeDigest string
	daemonHTTPPort     int
	capability         string
}

type BrokerHTTPError struct {
	StatusCode int
	Code       string
}

func (e *BrokerHTTPError) Error() string {
	return fmt.Sprintf("connected-account request-auth broker rejected the operation (status %d, code %s)", e.StatusCode, e.Code)
}

func NewHTTPBroker(config HTTPBrokerConfig) (*HTTPBroker, error) {
	if !filepath.IsAbs(config.CapabilityPath) {
		return nil, fmt.Errorf("request-auth capability path must be absolute")
	}
	return &HTTPBroker{
		config: config,
		client: &http.Client{
			Timeout: requestAuthBrokerTransportTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("request-auth broker redirects are not allowed")
			},
		},
	}, nil
}

func (b *HTTPBroker) LookupRequestAuth(ctx context.Context, purpose QualifiedPurpose) (OAuthBearerLease, error) {
	if err := purpose.validate(); err != nil {
		return OAuthBearerLease{}, fmt.Errorf("request-auth purpose is invalid: %w", err)
	}
	var lease OAuthBearerLease
	err := b.post(ctx, ConnectedAccountRequestAuthLookupPath, struct {
		Purpose QualifiedPurpose `json:"purpose"`
	}{Purpose: purpose}, &lease)
	if err != nil {
		return OAuthBearerLease{}, err
	}
	if err := validateLease(lease, time.Now()); err != nil {
		return OAuthBearerLease{}, fmt.Errorf("request-auth broker returned an invalid lease: %w", err)
	}
	return lease, nil
}

func (b *HTTPBroker) ReportAuthFailure(ctx context.Context, request ConnectedAccountAuthFailureRequest) (RequestAuthFailureOutcome, error) {
	if request.NormalizedFailure.Class != "authentication" {
		return RequestAuthFailureOutcome{}, fmt.Errorf("auth-failure report must use authentication class")
	}
	var outcome RequestAuthFailureOutcome
	if err := b.post(ctx, ConnectedAccountRequestAuthFailurePath, request, &outcome); err != nil {
		return RequestAuthFailureOutcome{}, err
	}
	if !validFailureStatus(outcome.Status) {
		return RequestAuthFailureOutcome{}, fmt.Errorf("request-auth broker returned an invalid failure outcome")
	}
	return outcome, nil
}

func (b *HTTPBroker) ReportQuotaFailure(ctx context.Context, request ConnectedAccountQuotaFailureRequest) (RequestAuthFailureOutcome, error) {
	if request.NormalizedFailure.Class != "quota" {
		return RequestAuthFailureOutcome{}, fmt.Errorf("quota-failure report must use quota class")
	}
	var outcome RequestAuthFailureOutcome
	if err := b.post(ctx, ConnectedAccountRequestAuthQuotaFailurePath, request, &outcome); err != nil {
		return RequestAuthFailureOutcome{}, err
	}
	if !validFailureStatus(outcome.Status) {
		return RequestAuthFailureOutcome{}, fmt.Errorf("request-auth broker returned an invalid failure outcome")
	}
	return outcome, nil
}

func (b *HTTPBroker) post(ctx context.Context, path string, input, output any) error {
	if b == nil || b.client == nil {
		return fmt.Errorf("request-auth broker is not initialized")
	}
	transport, err := b.readTransportTuple()
	if err != nil {
		return err
	}
	body, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode request-auth broker request: %w", err)
	}
	endpoint := url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", transport.daemonHTTPPort),
		Path:   path,
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request-auth broker request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(ConnectedAccountCapabilityHeader, transport.capability)
	response, err := b.client.Do(request)
	if err != nil {
		return fmt.Errorf("request-auth broker operation failed: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if response.StatusCode == http.StatusUnauthorized {
		return &BrokerHTTPError{
			StatusCode: http.StatusServiceUnavailable,
			Code:       "request_auth_unavailable",
		}
	}
	if err != nil {
		return fmt.Errorf("read request-auth broker response: %w", err)
	}
	if len(responseBody) > 256*1024 {
		return fmt.Errorf("request-auth broker response is too large")
	}
	responseErr := decodeBrokerEnvelope(response.StatusCode, responseBody, output)
	return responseErr
}

func (b *HTTPBroker) readTransportTuple() (requestAuthTransportTuple, error) {
	transport, err := readScopedCapability(b.config.CapabilityPath)
	if err != nil {
		return requestAuthTransportTuple{}, err
	}
	return transport, nil
}

func decodeBrokerEnvelope(status int, body []byte, output any) error {
	var envelope map[string]json.RawMessage
	if err := decodeStrictJSON(body, &envelope); err != nil {
		return fmt.Errorf("request-auth broker returned invalid JSON")
	}
	rawOK, hasOK := envelope["ok"]
	if !hasOK {
		return fmt.Errorf("request-auth broker response omitted ok")
	}
	var ok bool
	if err := json.Unmarshal(rawOK, &ok); err != nil {
		return fmt.Errorf("request-auth broker response has invalid ok")
	}
	if status == http.StatusOK {
		if !ok || len(envelope) != 2 {
			return fmt.Errorf("request-auth broker success envelope is invalid")
		}
		rawValue, hasValue := envelope["value"]
		if !hasValue || decodeStrictJSON(rawValue, output) != nil {
			return fmt.Errorf("request-auth broker success value is invalid")
		}
		return nil
	}
	if ok || len(envelope) != 2 {
		return fmt.Errorf("request-auth broker error envelope is invalid")
	}
	rawError, hasError := envelope["error"]
	if !hasError {
		return fmt.Errorf("request-auth broker error envelope omitted error")
	}
	var wireError struct {
		Code string `json:"code"`
	}
	if err := decodeStrictJSON(rawError, &wireError); err != nil {
		return fmt.Errorf("request-auth broker error value is invalid")
	}
	if !validBrokerErrorCode(status, wireError.Code) {
		return fmt.Errorf("request-auth broker error code is invalid")
	}
	return &BrokerHTTPError{StatusCode: status, Code: wireError.Code}
}

func decodeStrictJSON(data []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("trailing JSON")
		}
		return err
	}
	return nil
}

func readScopedCapability(path string) (requestAuthTransportTuple, error) {
	data, err := readBoundedPrivateFile(path, 64*1024)
	if err != nil {
		return requestAuthTransportTuple{}, &BrokerHTTPError{
			StatusCode: http.StatusServiceUnavailable,
			Code:       "request_auth_unavailable",
		}
	}
	var document struct {
		V                  int    `json:"v"`
		MaterializationID  string `json:"materializationId"`
		SubjectScopeDigest string `json:"subjectScopeDigest"`
		Capability         string `json:"capability"`
		HTTPPort           int    `json:"httpPort"`
	}
	if err := decodeStrictJSON(data, &document); err != nil {
		return requestAuthTransportTuple{}, fmt.Errorf("request-auth capability document is invalid")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(document.Capability)
	if document.V != 2 ||
		document.MaterializationID == "" ||
		len(document.MaterializationID) > 256 ||
		document.MaterializationID != strings.TrimSpace(document.MaterializationID) ||
		!isLowerHexSHA256(document.SubjectScopeDigest) ||
		err != nil ||
		len(decoded) != 32 ||
		document.HTTPPort < 1 ||
		document.HTTPPort > 65535 {
		return requestAuthTransportTuple{}, fmt.Errorf("request-auth capability document is invalid")
	}
	return requestAuthTransportTuple{
		materializationID:  document.MaterializationID,
		subjectScopeDigest: document.SubjectScopeDigest,
		daemonHTTPPort:     document.HTTPPort,
		capability:         document.Capability,
	}, nil
}

func isLowerHexSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func readBoundedPrivateFile(path string, limit int64) ([]byte, error) {
	parentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.Mode().IsDir() {
		return nil, fmt.Errorf("private file parent is unsafe")
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("private file path is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !fileInfo.Mode().IsRegular() || !os.SameFile(pathInfo, fileInfo) {
		return nil, fmt.Errorf("private file changed during open")
	}
	if runtime.GOOS != "windows" {
		if fileInfo.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("private file permissions are too broad")
		}
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("private file is too large")
	}
	finalPathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	finalParentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if finalPathInfo.Mode()&os.ModeSymlink != 0 ||
		!finalPathInfo.Mode().IsRegular() ||
		!os.SameFile(fileInfo, finalPathInfo) {
		return nil, fmt.Errorf("private file changed during read")
	}
	if finalParentInfo.Mode()&os.ModeSymlink != 0 ||
		!finalParentInfo.Mode().IsDir() ||
		!os.SameFile(parentInfo, finalParentInfo) {
		return nil, fmt.Errorf("private file parent changed during read")
	}
	return data, nil
}

func validFailureStatus(status FailureStatus) bool {
	switch status {
	case FailureStatusStaleContext, FailureStatusCurrentUnchanged, FailureStatusCurrentChanged, FailureStatusDenied:
		return true
	default:
		return false
	}
}

func validBrokerErrorCode(status int, code string) bool {
	switch status {
	case http.StatusUnauthorized:
		return code == "request_auth_unauthorized"
	case http.StatusForbidden:
		return code == "request_auth_purpose_forbidden"
	case http.StatusConflict:
		return code == "request_auth_not_active"
	case http.StatusServiceUnavailable:
		return code == "request_auth_unavailable"
	default:
		return false
	}
}
