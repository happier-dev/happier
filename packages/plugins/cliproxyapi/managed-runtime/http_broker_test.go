package managedruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPBrokerBoundsTransportLifetimeAndPreservesCallerCancellation(t *testing.T) {
	t.Parallel()

	capabilityPath := filepath.Join(t.TempDir(), "capability.json")
	writeCapabilityV2(t, capabilityPath, testCapability(24), 32123)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: capabilityPath})
	if err != nil {
		t.Fatal(err)
	}
	if got := broker.client.Timeout; got != 30*time.Second {
		t.Fatalf("broker transport timeout = %s, want 30s bounded request-auth lifetime", got)
	}

	started := make(chan struct{})
	broker.client.Transport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	lookupContext, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, lookupErr := broker.LookupRequestAuth(lookupContext, testPurpose("openai-upstream"))
		result <- lookupErr
	}()
	<-started
	cancel()
	select {
	case lookupErr := <-result:
		if !errors.Is(lookupErr, context.Canceled) {
			t.Fatalf("cancelled lookup error = %v, want context cancellation", lookupErr)
		}
	case <-time.After(time.Second):
		t.Fatal("caller cancellation did not terminate broker request")
	}
}

func TestNormalizedHTTPFailureEmitsCanonicalRequestAuthEvidence(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name              string
		class             string
		status            int
		wantLimitCategory string
	}{
		{
			name:              "authentication",
			class:             "authentication",
			status:            http.StatusUnauthorized,
			wantLimitCategory: "auth_invalid",
		},
		{
			name:              "quota",
			class:             "quota",
			status:            http.StatusTooManyRequests,
			wantLimitCategory: "rate_limit",
		},
		{
			name:              "capacity",
			class:             "quota",
			status:            529,
			wantLimitCategory: "capacity",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			response := &http.Response{
				StatusCode: testCase.status,
				Header:     make(http.Header),
			}
			encoded, err := json.Marshal(normalizedHTTPFailure(testCase.class, response))
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Class    string `json:"class"`
				Evidence struct {
					HTTPStatus     int    `json:"httpStatus"`
					LimitCategory  string `json:"limitCategory"`
					QuotaScope     string `json:"quotaScope"`
					EvidenceSource struct {
						Kind string `json:"kind"`
					} `json:"evidenceSource"`
				} `json:"evidence"`
			}
			if err := json.Unmarshal(encoded, &wire); err != nil {
				t.Fatal(err)
			}
			if wire.Class != testCase.class {
				t.Fatalf("class = %q, want %q", wire.Class, testCase.class)
			}
			if wire.Evidence.HTTPStatus != testCase.status {
				t.Fatalf("httpStatus = %d, want %d", wire.Evidence.HTTPStatus, testCase.status)
			}
			if wire.Evidence.LimitCategory != testCase.wantLimitCategory {
				t.Fatalf(
					"limitCategory = %q, want %q",
					wire.Evidence.LimitCategory,
					testCase.wantLimitCategory,
				)
			}
			if wire.Evidence.QuotaScope != "unknown" {
				t.Fatalf("quotaScope = %q, want unknown", wire.Evidence.QuotaScope)
			}
			if wire.Evidence.EvidenceSource.Kind != "structured" {
				t.Fatalf(
					"evidenceSource.kind = %q, want structured",
					wire.Evidence.EvidenceSource.Kind,
				)
			}
		})
	}
}

func TestHTTPBrokerReadsTheAtomicV2CapabilityTransportTuple(t *testing.T) {
	var networkCalls atomic.Int32
	capability := testCapability(16)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		networkCalls.Add(1)
		if got := request.Header.Get(ConnectedAccountCapabilityHeader); got != capability {
			t.Errorf("capability header = %q, want current V2 capability", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"ok":    true,
			"value": validLease("v2-lease", nil),
		})
	}))
	defer server.Close()

	capabilityPath := filepath.Join(t.TempDir(), "capability.json")
	writeCapabilityV2(
		t,
		capabilityPath,
		capability,
		server.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	lease, err := broker.LookupRequestAuth(
		context.Background(),
		testPurpose("openai-upstream"),
	)
	if err != nil {
		t.Fatalf("V2 lookup failed: %v", err)
	}
	if lease.AccessToken != "v2-lease" {
		t.Fatalf("lease access token = %q", lease.AccessToken)
	}
	if networkCalls.Load() != 1 {
		t.Fatalf("V2 lookup made %d network calls, want 1", networkCalls.Load())
	}
}

func TestHTTPBrokerRejectsLegacySplitV1CapabilityBeforeNetwork(t *testing.T) {
	var networkCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		networkCalls.Add(1)
		http.Error(writer, "must not be reached", http.StatusInternalServerError)
	}))
	defer server.Close()

	capabilityPath := filepath.Join(t.TempDir(), "capability.json")
	legacyDocument := fmt.Sprintf(
		`{"v":1,"materializationId":"mat-1","subjectScopeDigest":"%s","capability":%q}`,
		strings.Repeat("a", 64),
		testCapability(17),
	)
	if err := os.WriteFile(capabilityPath, []byte(legacyDocument), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.LookupRequestAuth(
		context.Background(),
		testPurpose("openai-upstream"),
	); err == nil {
		t.Fatal("legacy split V1 capability authorized a request")
	}
	if networkCalls.Load() != 0 {
		t.Fatalf("legacy capability made %d network calls", networkCalls.Load())
	}
}

func TestHTTPBrokerRereadsScopedCapabilityForEveryDistinctOperation(t *testing.T) {
	var mu sync.Mutex
	var seen []struct {
		path       string
		capability string
	}
	lease := validLease("lease-token", map[string]string{"Chatgpt-Account-Id": "account-a"})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		seen = append(seen, struct {
			path       string
			capability string
		}{
			path:       request.URL.Path,
			capability: request.Header.Get(ConnectedAccountCapabilityHeader),
		})
		mu.Unlock()
		if request.Header.Get("Authorization") != "" || request.Header.Get("x-happier-control-token") != "" {
			t.Error("broker sent a master/control credential")
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case ConnectedAccountRequestAuthLookupPath:
			_ = json.NewEncoder(writer).Encode(map[string]any{"ok": true, "value": lease})
		case ConnectedAccountRequestAuthFailurePath, ConnectedAccountRequestAuthQuotaFailurePath:
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"ok":    true,
				"value": RequestAuthFailureOutcome{Status: FailureStatusCurrentUnchanged},
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	httpPort := server.Listener.Addr().(*net.TCPAddr).Port
	capabilityA := testCapability(1)
	capabilityB := testCapability(2)
	writeCapabilityV2(t, capabilityPath, capabilityA, httpPort)

	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatalf("NewHTTPBroker() error = %v", err)
	}
	if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err != nil {
		t.Fatalf("LookupRequestAuth() error = %v", err)
	}
	writeCapabilityV2(t, capabilityPath, capabilityB, httpPort)
	if _, err := broker.ReportAuthFailure(context.Background(), ConnectedAccountAuthFailureRequest{
		CredentialContext: lease.CredentialContext,
		NormalizedFailure: ConnectedAccountConsumerFailure{
			Class: "authentication",
			Evidence: BoundedProviderFailureEvidence{
				HTTPStatus:    intPointer(http.StatusUnauthorized),
				LimitCategory: "auth_invalid",
				QuotaScope:    "unknown",
				EvidenceSource: ProviderFailureEvidenceSource{
					Kind: "structured",
				},
			},
		},
	}); err != nil {
		t.Fatalf("ReportAuthFailure() error = %v", err)
	}
	if _, err := broker.ReportQuotaFailure(context.Background(), ConnectedAccountQuotaFailureRequest{
		CredentialContext: lease.CredentialContext,
		NormalizedFailure: ConnectedAccountConsumerFailure{
			Class: "quota",
			Evidence: BoundedProviderFailureEvidence{
				HTTPStatus:    intPointer(http.StatusTooManyRequests),
				LimitCategory: "rate_limit",
				QuotaScope:    "unknown",
				EvidenceSource: ProviderFailureEvidenceSource{
					Kind: "structured",
				},
			},
		},
	}); err != nil {
		t.Fatalf("ReportQuotaFailure() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	wantPaths := []string{
		ConnectedAccountRequestAuthLookupPath,
		ConnectedAccountRequestAuthFailurePath,
		ConnectedAccountRequestAuthQuotaFailurePath,
	}
	if len(seen) != len(wantPaths) {
		t.Fatalf("requests = %#v", seen)
	}
	for i, wantPath := range wantPaths {
		if seen[i].path != wantPath {
			t.Fatalf("request %d path = %q, want %q", i, seen[i].path, wantPath)
		}
		wantCapability := capabilityB
		if i == 0 {
			wantCapability = capabilityA
		}
		if seen[i].capability != wantCapability {
			t.Fatalf("request %d capability was not reread", i)
		}
	}
}

func TestHTTPBrokerPreservesBoundedStatusAndCodeWithoutRetryAuthority(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"ok":false,"error":{"code":"request_auth_not_active"}}`))
	}))
	defer server.Close()

	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	writeCapabilityV2(
		t,
		capabilityPath,
		testCapability(3),
		server.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: capabilityPath})
	if err != nil {
		t.Fatal(err)
	}
	_, err = broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
	var brokerError *BrokerHTTPError
	if !errors.As(err, &brokerError) {
		t.Fatalf("error = %T %v, want BrokerHTTPError", err, err)
	}
	if brokerError.StatusCode != http.StatusConflict || brokerError.Code != "request_auth_not_active" {
		t.Fatalf("broker error = %#v", brokerError)
	}
}

func TestHTTPBrokerBoundsResponsesAndPreservesUnauthorizedUnavailability(t *testing.T) {
	testCases := []struct {
		name       string
		status     int
		wantCode   string
		wantStatus int
	}{
		{
			name:   "success",
			status: http.StatusOK,
		},
		{
			name:   "error",
			status: http.StatusConflict,
		},
		{
			name:       "unauthorized",
			status:     http.StatusUnauthorized,
			wantCode:   "request_auth_unavailable",
			wantStatus: http.StatusServiceUnavailable,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			var daemonCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				daemonCalls.Add(1)
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(strings.Repeat(" ", 256*1024+1)))
			}))
			defer server.Close()

			capabilityPath := filepath.Join(t.TempDir(), "capability.json")
			writeCapabilityV2(
				t,
				capabilityPath,
				testCapability(19),
				server.Listener.Addr().(*net.TCPAddr).Port,
			)
			broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: capabilityPath})
			if err != nil {
				t.Fatal(err)
			}

			_, err = broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
			if testCase.wantCode == "" {
				if err == nil || !strings.Contains(err.Error(), "response is too large") {
					t.Fatalf("oversized response error = %T %v, want bounded local failure", err, err)
				}
			} else {
				var brokerError *BrokerHTTPError
				if !errors.As(err, &brokerError) {
					t.Fatalf("oversized unauthorized error = %T %v, want BrokerHTTPError", err, err)
				}
				if brokerError.Code != testCase.wantCode || brokerError.StatusCode != testCase.wantStatus {
					t.Fatalf("oversized unauthorized error = %#v", brokerError)
				}
			}
			if daemonCalls.Load() != 1 {
				t.Fatalf("oversized response made %d requests, want exactly one", daemonCalls.Load())
			}
		})
	}
}

func TestHTTPBrokerReclassifiesAtomicReplacementTupleWithoutResending(t *testing.T) {
	var oldDaemonCalls atomic.Int32
	var replacementDaemonCalls atomic.Int32
	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	oldCapability := testCapability(12)
	replacementCapability := testCapability(13)

	replacementDaemon := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		replacementDaemonCalls.Add(1)
		if request.Header.Get(ConnectedAccountCapabilityHeader) != replacementCapability {
			t.Errorf("replacement daemon capability = %q", request.Header.Get(ConnectedAccountCapabilityHeader))
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"ok":    true,
			"value": validLease("replacement-lease", nil),
		})
	}))
	defer replacementDaemon.Close()

	oldDaemon := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		oldDaemonCalls.Add(1)
		if request.Header.Get(ConnectedAccountCapabilityHeader) != oldCapability {
			t.Errorf("old daemon did not observe the old atomic tuple")
		}
		// Publish the replacement tuple only after this request captured the old one.
		// The broker may reclassify the resulting 401, but it must never resend it.
		replacementDocument := capabilityV2Document(
			replacementCapability,
			replacementDaemon.Listener.Addr().(*net.TCPAddr).Port,
		)
		replacementPath := capabilityPath + ".replacement"
		if err := os.WriteFile(
			replacementPath,
			[]byte(replacementDocument),
			0o600,
		); err != nil {
			t.Errorf("publish replacement capability tuple: %v", err)
			http.Error(writer, "capability publication failed", http.StatusInternalServerError)
			return
		}
		if err := os.Rename(replacementPath, capabilityPath); err != nil {
			t.Errorf("activate replacement capability tuple: %v", err)
			http.Error(writer, "capability activation failed", http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(
			`{"ok":false,"error":{"code":"request_auth_unauthorized"}}`,
		))
	}))
	defer oldDaemon.Close()

	writeCapabilityV2(
		t,
		capabilityPath,
		oldCapability,
		oldDaemon.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
	var brokerError *BrokerHTTPError
	if !errors.As(err, &brokerError) {
		t.Fatalf("mixed-tuple error = %T %v, want BrokerHTTPError", err, err)
	}
	if brokerError.StatusCode != http.StatusServiceUnavailable ||
		brokerError.Code != "request_auth_unavailable" {
		t.Fatalf("mixed-tuple error = %#v, want typed unavailable", brokerError)
	}
	if oldDaemonCalls.Load() != 1 || replacementDaemonCalls.Load() != 0 {
		t.Fatalf(
			"mixed-tuple call counts old=%d replacement=%d, want 1 and 0",
			oldDaemonCalls.Load(),
			replacementDaemonCalls.Load(),
		)
	}

	lease, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
	if err != nil {
		t.Fatalf("settled replacement lookup: %v", err)
	}
	if lease.AccessToken != "replacement-lease" {
		t.Fatalf("replacement lease access token = %q", lease.AccessToken)
	}
	if oldDaemonCalls.Load() != 1 || replacementDaemonCalls.Load() != 1 {
		t.Fatalf(
			"explicit replacement call counts old=%d replacement=%d, want 1 and 1",
			oldDaemonCalls.Load(),
			replacementDaemonCalls.Load(),
		)
	}
}

func TestHTTPBrokerReclassifiesUnreadablePostUnauthorizedTupleWithoutResending(t *testing.T) {
	var daemonCalls atomic.Int32
	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		daemonCalls.Add(1)
		if err := os.WriteFile(capabilityPath, []byte("{"), 0o600); err != nil {
			t.Errorf("corrupt post-401 capability: %v", err)
			http.Error(writer, "capability corruption failed", http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(
			`{"ok":false,"error":{"code":"request_auth_unauthorized"}}`,
		))
	}))
	defer server.Close()

	writeCapabilityV2(
		t,
		capabilityPath,
		testCapability(15),
		server.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
	var brokerError *BrokerHTTPError
	if !errors.As(err, &brokerError) {
		t.Fatalf("unreadable tuple error = %T %v, want BrokerHTTPError", err, err)
	}
	if brokerError.StatusCode != http.StatusServiceUnavailable ||
		brokerError.Code != "request_auth_unavailable" {
		t.Fatalf("unreadable tuple error = %#v, want typed unavailable", brokerError)
	}
	if daemonCalls.Load() != 1 {
		t.Fatalf("unreadable post-401 tuple made %d requests, want exactly one", daemonCalls.Load())
	}
}

func TestReadScopedCapabilityFailureIsTypedUnavailableWithoutExposingPrivatePath(t *testing.T) {
	privateDirectory := filepath.Join(t.TempDir(), "sentinel-private-request-auth")
	privatePath := filepath.Join(privateDirectory, "capability.json")

	_, err := readScopedCapability(privatePath)
	var brokerError *BrokerHTTPError
	if !errors.As(err, &brokerError) {
		t.Fatalf("readScopedCapability() error = %T %v, want BrokerHTTPError", err, err)
	}
	if brokerError.StatusCode != http.StatusServiceUnavailable ||
		brokerError.Code != "request_auth_unavailable" {
		t.Fatalf("readScopedCapability() error = %#v, want typed unavailable", brokerError)
	}
	if strings.Contains(err.Error(), privateDirectory) {
		t.Fatalf("capability read error exposed private path: %v", err)
	}
}

func TestHTTPBrokerReclassifiesStableUnauthorizedTupleWithoutResending(t *testing.T) {
	var daemonCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		daemonCalls.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(
			`{"ok":false,"error":{"code":"request_auth_unauthorized"}}`,
		))
	}))
	defer server.Close()

	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	writeCapabilityV2(
		t,
		capabilityPath,
		testCapability(14),
		server.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream"))
	var brokerError *BrokerHTTPError
	if !errors.As(err, &brokerError) {
		t.Fatalf("stable unauthorized error = %T %v, want BrokerHTTPError", err, err)
	}
	if brokerError.StatusCode != http.StatusServiceUnavailable ||
		brokerError.Code != "request_auth_unavailable" {
		t.Fatalf("stable unauthorized error = %#v, want typed unavailable", brokerError)
	}
	if daemonCalls.Load() != 1 {
		t.Fatalf("stable unauthorized made %d requests, want exactly one", daemonCalls.Load())
	}
}

func TestBrokerFailureEnvelopeIsStrictAndStatusBounded(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		status int
		code   string
	}{
		{status: http.StatusUnauthorized, code: "request_auth_unauthorized"},
		{status: http.StatusForbidden, code: "request_auth_purpose_forbidden"},
		{status: http.StatusConflict, code: "request_auth_not_active"},
		{status: http.StatusServiceUnavailable, code: "request_auth_unavailable"},
	} {
		testCase := testCase
		t.Run(fmt.Sprintf("accepts_%d_%s", testCase.status, testCase.code), func(t *testing.T) {
			var output struct{}
			err := decodeBrokerEnvelope(
				testCase.status,
				[]byte(fmt.Sprintf(`{"ok":false,"error":{"code":%q}}`, testCase.code)),
				&output,
			)
			var brokerError *BrokerHTTPError
			if !errors.As(err, &brokerError) {
				t.Fatalf("error = %T %v, want BrokerHTTPError", err, err)
			}
			if brokerError.StatusCode != testCase.status || brokerError.Code != testCase.code {
				t.Fatalf("broker error = %#v", brokerError)
			}
		})
	}

	testCases := []struct {
		name   string
		status int
		body   string
	}{
		{name: "unsupported status", status: http.StatusBadRequest, body: `{"ok":false,"error":{"code":"request_auth_unavailable"}}`},
		{name: "unknown code", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":"fixture_error"}}`},
		{name: "status and code disagree", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":"request_auth_not_active"}}`},
		{name: "ok true", status: http.StatusForbidden, body: `{"ok":true,"error":{"code":"request_auth_purpose_forbidden"}}`},
		{name: "extra outer field", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":"request_auth_purpose_forbidden"},"retry":true}`},
		{name: "extra nested field", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":"request_auth_purpose_forbidden","message":"details"}}`},
		{name: "wrong member", status: http.StatusForbidden, body: `{"ok":false,"value":{"code":"request_auth_purpose_forbidden"}}`},
		{name: "blank code", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":""}}`},
		{name: "padded code", status: http.StatusForbidden, body: `{"ok":false,"error":{"code":" request_auth_purpose_forbidden"}}`},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			var output struct{}
			err := decodeBrokerEnvelope(testCase.status, []byte(testCase.body), &output)
			if err == nil {
				t.Fatal("decodeBrokerEnvelope() error = nil, want strict rejection")
			}
			var brokerError *BrokerHTTPError
			if errors.As(err, &brokerError) {
				t.Fatalf("malformed envelope surfaced as authoritative BrokerHTTPError: %#v", brokerError)
			}
		})
	}
}

func TestHTTPBrokerMatchesProtocolRequestAuthHTTPV1Vectors(t *testing.T) {
	t.Parallel()

	data, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "protocol", "src", "connect",
		"connectedAccountRequestAuthHttpV1.vectors.json",
	))
	if err != nil {
		t.Fatalf("read Protocol request-auth HTTP vectors: %v", err)
	}
	var vectors struct {
		V     int `json:"v"`
		Paths struct {
			Lookup       string `json:"lookup"`
			AuthFailure  string `json:"authFailure"`
			QuotaFailure string `json:"quotaFailure"`
		} `json:"paths"`
		Responses []struct {
			Name   string          `json:"name"`
			Status int             `json:"status"`
			Body   json.RawMessage `json:"body"`
		} `json:"responses"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode Protocol request-auth HTTP vectors: %v", err)
	}
	if vectors.V != 1 {
		t.Fatalf("Protocol request-auth HTTP vector version = %d, want 1", vectors.V)
	}
	if vectors.Paths.Lookup != ConnectedAccountRequestAuthLookupPath ||
		vectors.Paths.AuthFailure != ConnectedAccountRequestAuthFailurePath ||
		vectors.Paths.QuotaFailure != ConnectedAccountRequestAuthQuotaFailurePath {
		t.Fatalf("broker paths do not match Protocol vectors: %#v", vectors.Paths)
	}

	for _, vector := range vectors.Responses {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			if vector.Status == http.StatusOK {
				var output RequestAuthFailureOutcome
				if err := decodeBrokerEnvelope(vector.Status, vector.Body, &output); err != nil {
					t.Fatalf("decode success vector: %v", err)
				}
				if output.Status != FailureStatusCurrentUnchanged {
					t.Fatalf("success outcome = %#v", output)
				}
				return
			}

			var wire struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(vector.Body, &wire); err != nil {
				t.Fatalf("decode error vector body: %v", err)
			}
			var output struct{}
			err := decodeBrokerEnvelope(vector.Status, vector.Body, &output)
			var brokerError *BrokerHTTPError
			if !errors.As(err, &brokerError) {
				t.Fatalf("error vector = %T %v, want BrokerHTTPError", err, err)
			}
			if brokerError.StatusCode != vector.Status || brokerError.Code != wire.Error.Code {
				t.Fatalf("broker error = %#v, vector status = %d code = %q", brokerError, vector.Status, wire.Error.Code)
			}
		})
	}
}

func TestHTTPBrokerFailsBeforeNetworkWhenCapabilityIsNotActivated(t *testing.T) {
	var networkCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		networkCalls.Add(1)
		http.Error(writer, "must not be reached", http.StatusInternalServerError)
	}))
	defer server.Close()

	runtimeDir := t.TempDir()
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: filepath.Join(runtimeDir, "not-activated.json"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err == nil {
		t.Fatal("lookup before capability activation succeeded")
	}
	if networkCalls.Load() != 0 {
		t.Fatalf("lookup before capability activation made %d network calls", networkCalls.Load())
	}
}

func TestHTTPBrokerRejectsSymlinkedPrivateAuthorityBeforeNetwork(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires host-specific privileges")
	}

	var networkCalls atomic.Int32
	lease := validLease("lease-token", nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		networkCalls.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"ok": true, "value": lease})
	}))
	defer server.Close()

	runtimeDir := t.TempDir()
	capabilityTarget := filepath.Join(runtimeDir, "capability-target.json")
	writeCapabilityV2(
		t,
		capabilityTarget,
		testCapability(4),
		server.Listener.Addr().(*net.TCPAddr).Port,
	)

	t.Run("capability", func(t *testing.T) {
		capabilityPath := filepath.Join(runtimeDir, "capability-symlink.json")
		if err := os.Symlink(capabilityTarget, capabilityPath); err != nil {
			t.Fatal(err)
		}
		broker, err := NewHTTPBroker(HTTPBrokerConfig{
			CapabilityPath: capabilityPath,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err == nil {
			t.Fatal("symlinked capability authorized a request")
		}
	})

	t.Run("capability parent", func(t *testing.T) {
		capabilityTargetDir := filepath.Join(runtimeDir, "capability-parent-target")
		capabilityTargetPath := filepath.Join(capabilityTargetDir, "capability.json")
		capabilityParentPath := filepath.Join(runtimeDir, "request-auth")
		if err := os.Mkdir(capabilityTargetDir, 0o700); err != nil {
			t.Fatal(err)
		}
		writeCapabilityV2(
			t,
			capabilityTargetPath,
			testCapability(8),
			server.Listener.Addr().(*net.TCPAddr).Port,
		)
		if err := os.Symlink(capabilityTargetDir, capabilityParentPath); err != nil {
			t.Fatal(err)
		}
		broker, err := NewHTTPBroker(HTTPBrokerConfig{
			CapabilityPath: filepath.Join(capabilityParentPath, "capability.json"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err == nil {
			t.Fatal("capability below a symlinked private parent authorized a request")
		}
	})

	if networkCalls.Load() != 0 {
		t.Fatalf("unsafe private authority made %d network calls", networkCalls.Load())
	}
}

func TestHTTPBrokerRereadsDaemonReplacementAndFailsClosedAfterCapabilityRevocation(t *testing.T) {
	type observation struct {
		daemon     string
		capability string
	}
	var mu sync.Mutex
	var seen []observation
	server := func(daemon string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			mu.Lock()
			seen = append(seen, observation{
				daemon:     daemon,
				capability: request.Header.Get(ConnectedAccountCapabilityHeader),
			})
			mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"ok":    true,
				"value": validLease("lease-"+daemon, nil),
			})
		}))
	}
	daemonA := server("a")
	defer daemonA.Close()
	daemonB := server("b")
	defer daemonB.Close()

	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	capabilityA := testCapability(6)
	capabilityB := testCapability(7)
	writeCapabilityV2(
		t,
		capabilityPath,
		capabilityA,
		daemonA.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err != nil {
		t.Fatalf("lookup through first daemon: %v", err)
	}

	writeCapabilityV2(
		t,
		capabilityPath,
		capabilityB,
		daemonB.Listener.Addr().(*net.TCPAddr).Port,
	)
	if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err != nil {
		t.Fatalf("lookup through replacement daemon: %v", err)
	}
	if err := os.Remove(capabilityPath); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err == nil {
		t.Fatal("lookup after capability revocation succeeded")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("network observations = %#v, want exactly two pre-revocation calls", seen)
	}
	if seen[0] != (observation{daemon: "a", capability: capabilityA}) {
		t.Fatalf("first observation = %#v", seen[0])
	}
	if seen[1] != (observation{daemon: "b", capability: capabilityB}) {
		t.Fatalf("replacement observation = %#v", seen[1])
	}
}

func TestLeaseTransportUsesCompletedBrokerLeaseAsTheOnlyUpstreamLinearizationBoundary(t *testing.T) {
	rejectingDaemon := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(
				`{"ok":false,"error":{"code":"request_auth_unavailable"}}`,
			))
		}))
	}
	beforeLeaseDaemon := rejectingDaemon()
	defer beforeLeaseDaemon.Close()
	afterLeaseDaemon := rejectingDaemon()
	defer afterLeaseDaemon.Close()

	authorizedDaemon := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Header.Get(ConnectedAccountCapabilityHeader) != testCapability(10) {
				t.Error("authorized daemon received the wrong scoped capability")
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"ok":    true,
				"value": validLease("authorized-before-crash", nil),
			})
		},
	))
	defer authorizedDaemon.Close()

	runtimeDir := t.TempDir()
	capabilityPath := filepath.Join(runtimeDir, "capability.json")
	writeCapabilityV2(
		t,
		capabilityPath,
		testCapability(9),
		beforeLeaseDaemon.Listener.Addr().(*net.TCPAddr).Port,
	)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	var upstreamCalls atomic.Int32
	var upstreamAuthorization string
	transport := &leaseRoundTripper{
		entry: AuthEntry{
			ID:                 "codex",
			Provider:           ProviderCodex,
			Purpose:            testPurpose("openai-upstream"),
			AllowedHTTPSOrigin: "https://upstream.invalid",
		},
		broker: broker,
		base: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			upstreamCalls.Add(1)
			upstreamAuthorization = request.Header.Get("Authorization")
			// Simulate replacement-daemon loss after the lease response has
			// completed but while this already-authorized attempt is in flight.
			writeCapabilityV2(
				t,
				capabilityPath,
				testCapability(11),
				afterLeaseDaemon.Listener.Addr().(*net.TCPAddr).Port,
			)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       http.NoBody,
				Request:    request,
			}, nil
		}),
	}

	newRequest := func() *http.Request {
		return httptest.NewRequest(
			http.MethodPost,
			"https://upstream.invalid/v1/responses",
			nil,
		)
	}
	if _, err := transport.RoundTrip(newRequest()); err == nil {
		t.Fatal("attempt whose lease was rejected reached the upstream boundary")
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("pre-lease failure caused %d upstream effects", upstreamCalls.Load())
	}

	writeCapabilityV2(
		t,
		capabilityPath,
		testCapability(10),
		authorizedDaemon.Listener.Addr().(*net.TCPAddr).Port,
	)
	response, err := transport.RoundTrip(newRequest())
	if err != nil {
		t.Fatalf("attempt authorized before replacement crash failed: %v", err)
	}
	_ = response.Body.Close()
	if upstreamCalls.Load() != 1 {
		t.Fatalf("completed lease caused %d upstream effects, want exactly 1", upstreamCalls.Load())
	}
	if upstreamAuthorization != "Bearer authorized-before-crash" {
		t.Fatalf("upstream Authorization = %q", upstreamAuthorization)
	}

	if _, err := transport.RoundTrip(newRequest()); err == nil {
		t.Fatal("post-crash attempt without current authority reached upstream")
	}
	if upstreamCalls.Load() != 1 {
		t.Fatalf("post-crash failure replayed upstream; effects = %d", upstreamCalls.Load())
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func writeCapabilityV2(t *testing.T, path, capability string, httpPort int) {
	t.Helper()
	if err := os.WriteFile(
		path,
		[]byte(capabilityV2Document(capability, httpPort)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
}

func capabilityV2Document(capability string, httpPort int) string {
	return fmt.Sprintf(
		`{"v":2,"materializationId":"mat-1","subjectScopeDigest":"%s","capability":%q,"httpPort":%d}`,
		strings.Repeat("a", 64),
		capability,
		httpPort,
	)
}

func testCapability(seed byte) string {
	bytes := make([]byte, 32)
	for i := range bytes {
		bytes[i] = seed
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}

func intPointer(value int) *int {
	return &value
}
