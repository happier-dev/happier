package managedruntime

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// The daemon transport is the genuine process boundary. Exercise its decoder
// with wire material rather than injecting an already parsed broker result.
func TestHTTPBrokerAcceptsCompleteNonBearerRequestAuthMaterial(t *testing.T) {
	for _, headers := range []string{`{"x-goog-api-key":"fake-key"}`, `{"authorization":"Basic fake-session"}`, `{}`} {
		t.Run(headers, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "capability.json")
			writeCapabilityV2(t, path, testCapability(25), 32123)
			broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: path})
			if err != nil {
				t.Fatal(err)
			}
			broker.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"ok":true,"value":{"headers":` + headers + `,"facts":{"projectId":"fake-project","usingApi":false,"attempt":1},"credentialContext":{"account":{"service":{"pluginId":"happier.plugin.fixture","localId":"account"},"accountId":"selected"},"credentialRevision":"csr_abcdefghijklmnopqrstuv"}}}`))}, nil
			})
			material, err := broker.LookupRequestAuth(context.Background(), QualifiedPurpose{Consumer: ContributionIdentity{PluginID: "happier.plugin.cliproxyapi", LocalID: "gateway"}, Purpose: "fixture-upstream"})
			if err != nil {
				t.Fatalf("complete request material refused: %v", err)
			}
			if material.Facts["projectId"] != "fake-project" || material.Facts["usingApi"] != false || material.Facts["attempt"] != float64(1) {
				t.Fatal("request-local scalar facts were lost at the process boundary")
			}
			capture := &captureRoundTripper{}
			transport := &leaseRoundTripper{entry: testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream"), broker: &sequenceBroker{leases: []RequestAuthHeaders{material}}, base: capture}
			request, _ := http.NewRequest(http.MethodPost, "https://upstream.invalid/v1/responses", nil)
			request.Header.Set("Authorization", "Bearer stale-sentinel")
			if _, err := transport.RoundTrip(request); err != nil {
				t.Fatal(err)
			}
			actual := capture.requests()[0].Header
			if material.Headers["x-goog-api-key"] != "" {
				if actual.Get("x-goog-api-key") != "fake-key" || actual.Get("Authorization") != "" {
					t.Fatal("key-only material gained a Bearer credential")
				}
			} else if actual.Get("Authorization") != material.Headers["authorization"] {
				t.Fatal("request-auth material was rewritten or gained a credential")
			}
		})
	}
}

func TestHTTPBrokerRejectsStructuredExecutorFacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capability.json")
	writeCapabilityV2(t, path, testCapability(25), 32123)
	broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: path})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{nil, []string{"nested"}, map[string]string{"nested": "value"}} {
		material := validLease("fake-key", nil)
		material.Facts["invalid"] = value
		broker.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return brokerSuccessEnvelope(material)
		})
		if _, err := broker.LookupRequestAuth(context.Background(), testPurpose("openai-upstream")); err == nil {
			t.Fatal("structured fact crossed the request-auth process boundary")
		}
	}
}

func TestRequestAuthTransportChecksTheDeclaredOriginListOnEveryRequest(t *testing.T) {
	entry := testLeaseAuthEntry("codex", ProviderCodex, "openai-upstream")
	entry.AllowedHTTPSOrigins = []string{"https://first.invalid", "https://second.invalid"}
	broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("first", nil), validLease("second", nil)}}
	capture := &captureRoundTripper{}
	transport := &leaseRoundTripper{entry: entry, broker: broker, base: capture}
	for _, origin := range entry.AllowedHTTPSOrigins {
		request, _ := http.NewRequest(http.MethodPost, origin+"/inference", nil)
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatal(err)
		}
	}
	for _, origin := range []string{"https://third.invalid", "http://first.invalid", "https://first.invalid.evil"} {
		request, _ := http.NewRequest(http.MethodPost, origin+"/inference", nil)
		if _, err := transport.RoundTrip(request); err == nil {
			t.Fatal("undeclared origin acquired request credentials")
		}
	}
	if len(broker.purposes()) != 2 || len(capture.requests()) != 2 {
		t.Fatal("origin refusal must occur before borrowing or sending credentials")
	}
}
