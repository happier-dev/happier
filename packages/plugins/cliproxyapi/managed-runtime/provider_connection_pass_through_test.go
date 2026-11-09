package managedruntime

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func providerSourceHeader(t *testing.T, source ProviderConnectionRequestSource) string {
	t.Helper()
	raw, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func TestProviderConnectionPassThroughIndependentCredentials(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name     string
		names    []string
		material map[string]string
		status   int
	}{
		{"independent credentials", []string{"x-api-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-api-key": "upstream-secret"}, http.StatusOK},
		{"missing companion", []string{"x-api-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret"}, http.StatusForbidden},
		{"missing companion carrier", []string{"x-api-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-api-key": "upstream-secret"}, http.StatusForbidden},
		{"undeclared companion material", []string{}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-api-key": "upstream-secret"}, http.StatusForbidden},
		{"wrong companion metadata", []string{"x-other-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-api-key": "upstream-secret"}, http.StatusForbidden},
		{"missing primary", []string{"x-api-key"}, map[string]string{"x-api-key": "upstream-secret"}, http.StatusServiceUnavailable},
		{"unexpected credential", []string{"x-api-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-other": "undeclared"}, http.StatusForbidden},
		{"case-equivalent collision", []string{"X-GATEWAY-TOKEN"}, map[string]string{"x-gateway-token": "Bearer gateway-secret"}, http.StatusForbidden},
		{"control-bearing companion", []string{"x-api-key"}, map[string]string{"x-gateway-token": "Bearer gateway-secret", "x-api-key": "bad\r\nvalue"}, http.StatusForbidden},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			requests := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				requests++
				if request.Header.Get("x-api-key") != "upstream-secret" || request.Header.Get("x-gateway-token") != "Bearer gateway-secret" || request.Header.Get("authorization") != "" {
					t.Error("independent credential authority was not preserved")
				}
				writer.WriteHeader(http.StatusOK)
			}))
			defer upstream.Close()
			descriptor, _ := json.Marshal(map[string]interface{}{"baseUrl": upstream.URL, "resolvedAddresses": []string{"127.0.0.1"}, "publicHeaders": map[string]string{}, "credentialHeaderName": "x-gateway-token", "additionalCredentialHeaderNames": testCase.names})
			primary := testCase.material["x-gateway-token"]
			delete(testCase.material, "x-gateway-token")
			material, _ := json.Marshal(testCase.material)
			router := gin.New()
			router.Use(ProviderConnectionPassThroughMiddleware(ProviderConnectionPassThroughConfiguration{Protocol: ProtocolAnthropic, DownstreamBasePath: "/"}, nil))
			router.Any("/*path", func(c *gin.Context) { c.Status(http.StatusTeapot) })
			request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader("{}"))
			request.Header.Set(ProviderConnectionDescriptorHeader, base64.RawURLEncoding.EncodeToString(descriptor))
			request.Header.Set(ProviderConnectionCredentialHeader, primary)
			if testCase.name != "missing companion carrier" {
				request.Header.Set(ProviderConnectionAdditionalCredentialsHeader, base64.RawURLEncoding.EncodeToString(material))
			}
			request.Header.Set("authorization", "Bearer worker")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != testCase.status {
				t.Fatalf("expected status %d, got %d", testCase.status, recorder.Code)
			}
			if testCase.status != http.StatusOK && requests != 0 {
				t.Fatal("refused credential reached upstream")
			}
		})
	}
}

func TestProviderConnectionPassThroughAcceptsCanonicalSourceWithoutLocalCapacityCaps(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name            string
		addresses       int
		headers         int
		value           string
		descriptorChars int
		reject          bool
	}{
		{name: "all admitted DNS answers", addresses: 17},
		{name: "source just below SVC09 header value boundary", addresses: 1, headers: 2, descriptorChars: 8191},
		{name: "source at SVC09 header value boundary", addresses: 1, headers: 2, descriptorChars: 8192},
		{name: "canonical escaped public headers", addresses: 1, headers: 64},
		{name: "canonical character bound for Latin-1 public headers", addresses: 1, headers: 1, value: strings.Repeat("é", 2500)},
		{name: "rejects values beyond canonical character bound", addresses: 1, headers: 1, value: strings.Repeat("a", 4097), reject: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			forwarded := make(chan http.Header, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				forwarded <- request.Header.Clone()
				_, _ = io.WriteString(writer, "ok")
			}))
			defer upstream.Close()
			source := ProviderConnectionRequestSource{BaseURL: upstream.URL, CredentialHeaderName: "authorization", PublicHeaders: make(map[string]string)}
			for index := 0; index < testCase.addresses; index++ {
				source.ResolvedAddresses = append(source.ResolvedAddresses, fmt.Sprintf("127.0.0.%d", index+1))
			}
			for index := 0; index < testCase.headers; index++ {
				value := testCase.value
				if value == "" {
					value = strings.Repeat("\"", 4096)
				}
				source.PublicHeaders[fmt.Sprintf("x-public-%d", index)] = value
			}
			if testCase.descriptorChars > 0 {
				source.PublicHeaders["x-public-0"] = strings.Repeat("x", 4096)
				source.PublicHeaders["x-public-1"] = ""
				raw, err := json.Marshal(source)
				if err != nil {
					t.Fatal(err)
				}
				source.PublicHeaders["x-public-1"] = strings.Repeat("x", testCase.descriptorChars*3/4-len(raw))
				if got := len(providerSourceHeader(t, source)); got != testCase.descriptorChars {
					t.Fatalf("expected carrier boundary descriptor, got %d", got)
				}
			}
			router := gin.New()
			router.Use(ProviderConnectionPassThroughMiddleware(ProviderConnectionPassThroughConfiguration{Protocol: ProtocolOpenAIResponses, DownstreamBasePath: "/v1"}, nil))
			router.Any("/*path", func(c *gin.Context) { c.Status(http.StatusTeapot) })
			request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader("{}"))
			request.Header.Set(ProviderConnectionCredentialHeader, "Bearer source-secret")
			request.Header.Set(ProviderConnectionDescriptorHeader, providerSourceHeader(t, source))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if testCase.reject {
				if recorder.Code != http.StatusForbidden || len(forwarded) != 0 {
					t.Fatalf("invalid public header reached final hop: status %d", recorder.Code)
				}
				return
			}
			if recorder.Code != http.StatusOK || len(forwarded) != 1 {
				t.Fatalf("canonical source did not reach final hop: status %d", recorder.Code)
			}
			lastHeader := fmt.Sprintf("x-public-%d", testCase.headers-1)
			headers := <-forwarded
			if testCase.headers > 0 && headers.Get(lastHeader) != source.PublicHeaders[lastHeader] {
				t.Fatal("final admitted public header was lost")
			}
		})
	}
}

func TestProviderConnectionPassThroughOwnsFinalHopAuthorizationForBothProtocols(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name          string
		protocol      ProviderProtocol
		downstream    string
		baseURL       string
		credentialKey string
		credential    string
		wantURL       string
	}{
		{"OpenAI responses", ProtocolOpenAIResponses, "/v1/responses?stream=true", "https://gateway.example/root", "authorization", "Bearer source-secret", "https://gateway.example/root/responses?stream=true"},
		{"OpenAI chat", ProtocolOpenAIChat, "/v1/chat/completions", "https://gateway.example/api/v1", "authorization", "Bearer source-secret", "https://gateway.example/api/v1/chat/completions"},
		{"Anthropic", ProtocolAnthropic, "/v1/messages", "https://anthropic.example/root", "x-api-key", "source-key", "https://anthropic.example/root/v1/messages"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var got *http.Request
			body := `{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"cost":0.12,"cost_details":{"upstream_inference_cost":9}}}`
			transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
				got = request.Clone(request.Context())
				got.Header = request.Header.Clone()
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}, "Set-Cookie": []string{"private=1"}},
					Body:       io.NopCloser(bytes.NewBufferString(body)),
				}, nil
			})
			router := gin.New()
			router.Use(ProviderConnectionPassThroughMiddleware(ProviderConnectionPassThroughConfiguration{
				Protocol: testCase.protocol,
				DownstreamBasePath: func() string {
					if testCase.protocol == ProtocolAnthropic {
						return "/"
					}
					return "/v1"
				}(),
			}, transport))
			router.Any("/*path", func(c *gin.Context) { c.Status(http.StatusTeapot) })

			request := httptest.NewRequest(http.MethodPost, testCase.downstream, bytes.NewBufferString("{}"))
			request.Header.Set("Authorization", "Bearer caller-must-not-cross")
			request.Header.Set("X-Api-Key", "caller-key-must-not-cross")
			request.Header.Set("X-Client", "worker")
			request.Header.Set(ProviderConnectionCredentialHeader, testCase.credential)
			request.Header.Set(ProviderConnectionDescriptorHeader, providerSourceHeader(t, ProviderConnectionRequestSource{
				BaseURL: testCase.baseURL, ResolvedAddresses: []string{"203.0.113.10"},
				PublicHeaders: map[string]string{"x-provider-client": "happier"}, CredentialHeaderName: testCase.credentialKey,
			}))
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK || got == nil {
				t.Fatalf("status = %d, request = %#v", recorder.Code, got)
			}
			if recorder.Body.String() != body {
				t.Fatal("Provider terminal usage or reported cost changed in the pass-through response")
			}
			if got.URL.String() != testCase.wantURL || got.Header.Get(testCase.credentialKey) != testCase.credential {
				t.Fatalf("final hop URL/header = %q / %q", got.URL, got.Header.Get(testCase.credentialKey))
			}
			if got.Header.Get("x-provider-client") != "happier" || got.Header.Get("x-client") != "worker" {
				t.Fatalf("public/caller headers = %#v", got.Header)
			}
			if testCase.credentialKey != "authorization" && got.Header.Get("authorization") != "" {
				t.Fatal("caller authorization crossed the managed final hop")
			}
			if testCase.credentialKey != "x-api-key" && got.Header.Get("x-api-key") != "" {
				t.Fatal("caller API key crossed the managed final hop")
			}
			if recorder.Header().Get("set-cookie") != "" {
				t.Fatal("upstream cookie crossed the managed response boundary")
			}
		})
	}
}

func TestProviderConnectionPassThroughRefusesHeaderCollisionAndRedirect(t *testing.T) {
	t.Parallel()
	source := providerSourceHeader(t, ProviderConnectionRequestSource{
		BaseURL: "https://gateway.example", ResolvedAddresses: []string{"203.0.113.10"},
		PublicHeaders: map[string]string{"x-provider-client": "happier"}, CredentialHeaderName: "authorization",
	})
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": []string{"https://attacker.invalid/"}},
			Body:       io.NopCloser(bytes.NewBuffer(nil)),
			Request:    request,
		}, nil
	})
	router := gin.New()
	router.Use(ProviderConnectionPassThroughMiddleware(ProviderConnectionPassThroughConfiguration{
		Protocol: ProtocolOpenAIResponses, DownstreamBasePath: "/v1",
	}, transport))
	router.Any("/*path", func(c *gin.Context) { c.Status(http.StatusTeapot) })
	makeRequest := func(collision bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
		request.Header.Set(ProviderConnectionCredentialHeader, "Bearer source")
		request.Header.Set(ProviderConnectionDescriptorHeader, source)
		if collision {
			request.Header.Set("X-Provider-Client", "caller")
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	if status := makeRequest(true).Code; status != http.StatusForbidden {
		t.Fatalf("collision status = %d", status)
	}
	if status := makeRequest(false).Code; status != http.StatusBadGateway {
		t.Fatalf("redirect status = %d", status)
	}
}

func TestProviderConnectionPassThroughAcceptsAuthorizedPrivateHTTPAndRefusesPublicHTTP(t *testing.T) {
	t.Parallel()
	private := ProviderConnectionRequestSource{
		BaseURL: "http://127.0.0.1:43123/v1", ResolvedAddresses: []string{"127.0.0.1"},
		PublicHeaders: map[string]string{}, CredentialHeaderName: "authorization",
	}
	if err := private.validate(); err != nil {
		t.Fatalf("authorized private HTTP source rejected: %v", err)
	}
	public := ProviderConnectionRequestSource{
		BaseURL: "http://gateway.example/v1", ResolvedAddresses: []string{"203.0.113.10"},
		PublicHeaders: map[string]string{}, CredentialHeaderName: "authorization",
	}
	if err := public.validate(); err == nil {
		t.Fatal("plaintext public Provider source was accepted")
	}
}

func TestPinnedSDKProviderConnectionPassThroughComposesThroughManagedGateway(t *testing.T) {
	port := reserveLoopbackPort(t)
	config := Config{
		Host: "127.0.0.1", Port: port, DownstreamBearer: "host-bearer", RuntimeDir: t.TempDir(),
		Protocols: []ProviderProtocol{ProtocolOpenAIResponses}, ModelListEnabled: false,
		ProviderConnection: &ProviderConnectionPassThroughConfiguration{Protocol: ProtocolOpenAIResponses, DownstreamBasePath: "/v1"},
	}
	var got *http.Request
	upstream := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		got = request.Clone(request.Context())
		got.Header = request.Header.Clone()
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(bytes.NewBufferString("data: done\n\n"))}, nil
	})
	gateway, err := NewGateway(config, testRuntimeIdentity(), nil, upstream)
	if err != nil {
		t.Fatalf("NewGateway() error = %v", err)
	}
	cancel, runResult := runGateway(t, gateway)
	defer stopGateway(t, cancel, runResult)
	identity := awaitManagedHealthIdentity(t, config)
	if identity.SourceClass != "provider_connection" || identity.ModelListEnabled || len(identity.Purposes) != 0 {
		t.Fatalf("health identity = %#v", identity)
	}

	request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+fmt.Sprint(port)+"/v1/responses?stream=true", bytes.NewBufferString("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+config.DownstreamBearer)
	request.Header.Set(ProviderConnectionCredentialHeader, "Bearer source-secret")
	request.Header.Set(ProviderConnectionDescriptorHeader, providerSourceHeader(t, ProviderConnectionRequestSource{
		BaseURL: "https://gateway.example/v1", ResolvedAddresses: []string{"203.0.113.10"},
		PublicHeaders: map[string]string{"x-provider-client": "happier"}, CredentialHeaderName: "authorization",
	}))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || string(body) != "data: done\n\n" {
		t.Fatalf("response = %d %q; error = %v", response.StatusCode, body, err)
	}
	if got == nil || got.URL.String() != "https://gateway.example/v1/responses?stream=true" || got.Header.Get("Authorization") != "Bearer source-secret" {
		t.Fatalf("final upstream request = %#v", got)
	}
}
