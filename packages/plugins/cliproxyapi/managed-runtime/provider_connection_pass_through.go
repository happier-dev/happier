package managedruntime

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/gin-gonic/gin"
)

const (
	ProviderConnectionCredentialHeader            = "X-Happier-Provider-Source-Credential"
	ProviderConnectionAdditionalCredentialsHeader = "X-Happier-Provider-Source-Additional-Credentials"
	ProviderConnectionDescriptorHeader            = "X-Happier-Provider-Source"
)

type ProviderConnectionRequestSource struct {
	BaseURL                         string            `json:"baseUrl"`
	ResolvedAddresses               []string          `json:"resolvedAddresses"`
	PublicHeaders                   map[string]string `json:"publicHeaders"`
	CredentialHeaderName            string            `json:"credentialHeaderName"`
	AdditionalCredentialHeaderNames []string          `json:"additionalCredentialHeaderNames,omitempty"`
}

var providerAuthenticationHeaders = map[string]struct{}{
	"authorization": {}, "proxy-authorization": {}, "x-api-key": {}, "api-key": {}, "x-goog-api-key": {},
}
var providerHopByHopHeaders = map[string]struct{}{
	"connection": {}, "keep-alive": {}, "proxy-authenticate": {}, "proxy-authorization": {},
	"te": {}, "trailer": {}, "transfer-encoding": {}, "upgrade": {},
}

func (configuration ProviderConnectionPassThroughConfiguration) clone() *ProviderConnectionPassThroughConfiguration {
	return &ProviderConnectionPassThroughConfiguration{Protocol: configuration.Protocol, DownstreamBasePath: configuration.DownstreamBasePath}
}

func (configuration ProviderConnectionPassThroughConfiguration) validate() error {
	if _, ok := protocolSurfaces[configuration.Protocol]; !ok {
		return fmt.Errorf("protocol is unsupported")
	}
	if configuration.DownstreamBasePath != "/" && configuration.DownstreamBasePath != "/v1" {
		return fmt.Errorf("downstream base path is invalid")
	}
	return nil
}

func (source ProviderConnectionRequestSource) validate() error {
	base, err := url.Parse(source.BaseURL)
	if err != nil || base == nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.User != nil ||
		base.Opaque != "" || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" ||
		base.Host != strings.ToLower(base.Host) || base.String() != source.BaseURL {
		return fmt.Errorf("base URL is invalid")
	}
	credentialName := strings.ToLower(source.CredentialHeaderName)
	if source.CredentialHeaderName != credentialName || !headerNamePattern.MatchString(credentialName) ||
		strings.EqualFold(credentialName, ProviderConnectionCredentialHeader) ||
		strings.EqualFold(credentialName, ProviderConnectionAdditionalCredentialsHeader) ||
		strings.EqualFold(credentialName, ProviderConnectionDescriptorHeader) {
		return fmt.Errorf("credential header name is invalid")
	}
	credentialNames := map[string]struct{}{credentialName: {}}
	for _, name := range source.AdditionalCredentialHeaderNames {
		if name != strings.ToLower(name) || !headerNamePattern.MatchString(name) || strings.EqualFold(name, ProviderConnectionCredentialHeader) || strings.EqualFold(name, ProviderConnectionDescriptorHeader) || strings.EqualFold(name, ProviderConnectionAdditionalCredentialsHeader) {
			return fmt.Errorf("credential header name is invalid")
		}
		if _, exists := credentialNames[name]; exists {
			return fmt.Errorf("credential header name is duplicated")
		}
		if _, hop := providerHopByHopHeaders[name]; hop {
			return fmt.Errorf("credential header name is invalid")
		}
		credentialNames[name] = struct{}{}
	}
	if len(source.ResolvedAddresses) == 0 {
		return fmt.Errorf("resolved addresses are invalid")
	}
	seenAddresses := make(map[string]struct{}, len(source.ResolvedAddresses))
	for _, address := range source.ResolvedAddresses {
		ip := net.ParseIP(address)
		if ip == nil || ip.String() != address {
			return fmt.Errorf("resolved addresses are invalid")
		}
		// Plain HTTP is only valid for the local/private endpoint class that
		// the canonical Provider resolver has already authorized. Keep this
		// defense at the final-hop process too, so a malformed private
		// descriptor can never downgrade a public Provider origin to plaintext.
		if base.Scheme == "http" && !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
			return fmt.Errorf("base URL is invalid")
		}
		if _, exists := seenAddresses[address]; exists {
			return fmt.Errorf("resolved addresses are invalid")
		}
		seenAddresses[address] = struct{}{}
	}
	if len(source.PublicHeaders) > 64 {
		return fmt.Errorf("public headers are invalid")
	}
	for rawName, value := range source.PublicHeaders {
		name := strings.ToLower(rawName)
		// Protocol's maxHeaderValueChars counts JavaScript UTF-16 code units,
		// not the UTF-8 bytes used by this private JSON carrier.
		if rawName != name || len(name) > 128 || !headerNamePattern.MatchString(name) || len(utf16.Encode([]rune(value))) > 4096 || strings.ContainsAny(value, "\x00\r\n") ||
			name == credentialName || strings.EqualFold(name, ProviderConnectionCredentialHeader) ||
			strings.EqualFold(name, ProviderConnectionDescriptorHeader) {
			return fmt.Errorf("public headers are invalid")
		}
		if strings.EqualFold(name, ProviderConnectionAdditionalCredentialsHeader) {
			return fmt.Errorf("public headers are invalid")
		}
		if _, sensitive := providerAuthenticationHeaders[name]; sensitive {
			return fmt.Errorf("public headers are invalid")
		}
		if _, collision := credentialNames[name]; collision {
			return fmt.Errorf("public headers collide with credentials")
		}
		if _, hop := providerHopByHopHeaders[name]; hop {
			return fmt.Errorf("public headers are invalid")
		}
	}
	return nil
}

func parseProviderConnectionRequestSource(value string) (ProviderConnectionRequestSource, error) {
	if value == "" {
		return ProviderConnectionRequestSource{}, fmt.Errorf("provider source is invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) == 0 {
		return ProviderConnectionRequestSource{}, fmt.Errorf("provider source is invalid")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var source ProviderConnectionRequestSource
	if err := decoder.Decode(&source); err != nil || decoder.Decode(&struct{}{}) != io.EOF || source.validate() != nil {
		return ProviderConnectionRequestSource{}, fmt.Errorf("provider source is invalid")
	}
	return source, nil
}

func providerConnectionTransport(source ProviderConnectionRequestSource) http.RoundTripper {
	addresses := append([]string(nil), source.ResolvedAddresses...)
	sort.Strings(addresses)
	base, _ := url.Parse(source.BaseURL)
	hostname := strings.ToLower(base.Hostname())
	dialer := &net.Dialer{}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || strings.ToLower(host) != hostname {
			return nil, fmt.Errorf("provider connection origin changed")
		}
		var lastErr error
		for _, resolved := range addresses {
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved, port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: hostname}
	return transport
}

func providerConnectionTarget(configuration ProviderConnectionPassThroughConfiguration, source ProviderConnectionRequestSource, requestURL *url.URL) (*url.URL, error) {
	if requestURL == nil || requestURL.IsAbs() || requestURL.Host != "" || requestURL.User != nil || requestURL.Fragment != "" {
		return nil, fmt.Errorf("provider request target is invalid")
	}
	path := requestURL.EscapedPath()
	if configuration.DownstreamBasePath != "/" {
		if path != configuration.DownstreamBasePath && !strings.HasPrefix(path, configuration.DownstreamBasePath+"/") {
			return nil, fmt.Errorf("provider request target is invalid")
		}
		path = strings.TrimPrefix(path, configuration.DownstreamBasePath)
		if path == "" {
			path = "/"
		}
	}
	base, _ := url.Parse(source.BaseURL)
	basePath := strings.TrimSuffix(base.EscapedPath(), "/")
	target, err := url.Parse(base.Scheme + "://" + base.Host + basePath + path)
	if err != nil || target == nil || target.Host != base.Host {
		return nil, fmt.Errorf("provider request target is invalid")
	}
	target.RawQuery = requestURL.RawQuery
	return target, nil
}

func ProviderConnectionPassThroughMiddleware(configuration ProviderConnectionPassThroughConfiguration, upstream http.RoundTripper) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request == nil || c.Request.URL == nil || c.Request.URL.Path == "/healthz" {
			c.Next()
			return
		}
		credentials := c.Request.Header.Values(ProviderConnectionCredentialHeader)
		descriptors := c.Request.Header.Values(ProviderConnectionDescriptorHeader)
		if len(credentials) != 1 || credentials[0] == "" || strings.IndexFunc(credentials[0], func(char rune) bool { return char < 32 || char == 127 }) >= 0 || len(descriptors) != 1 {
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		source, err := parseProviderConnectionRequestSource(descriptors[0])
		if err != nil {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		materials := map[string]string{source.CredentialHeaderName: credentials[0]}
		additional := c.Request.Header.Values(ProviderConnectionAdditionalCredentialsHeader)
		if len(source.AdditionalCredentialHeaderNames) == 0 && len(additional) != 0 {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		if len(source.AdditionalCredentialHeaderNames) > 0 {
			if len(additional) != 1 {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			raw, decodeError := base64.RawURLEncoding.DecodeString(additional[0])
			companions := make(map[string]string)
			if decodeError != nil || json.Unmarshal(raw, &companions) != nil || len(companions) != len(source.AdditionalCredentialHeaderNames) {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			for _, name := range source.AdditionalCredentialHeaderNames {
				value := companions[name]
				if value == "" || strings.IndexFunc(value, func(char rune) bool { return char < 32 || char == 127 }) >= 0 {
					c.AbortWithStatus(http.StatusForbidden)
					return
				}
				materials[name] = value
			}
		}
		target, err := providerConnectionTarget(configuration, source, c.Request.URL)
		if err != nil {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		outbound := c.Request.Clone(c.Request.Context())
		outbound.URL, outbound.Host, outbound.RequestURI, outbound.Header = target, target.Host, "", make(http.Header)
		for name, values := range c.Request.Header {
			normalized := strings.ToLower(name)
			if normalized == strings.ToLower(ProviderConnectionCredentialHeader) || normalized == strings.ToLower(ProviderConnectionDescriptorHeader) || normalized == strings.ToLower(ProviderConnectionAdditionalCredentialsHeader) || normalized == "host" {
				continue
			}
			if _, credential := materials[normalized]; credential {
				continue
			}
			if _, sensitive := providerAuthenticationHeaders[normalized]; sensitive {
				continue
			}
			if _, hop := providerHopByHopHeaders[normalized]; hop {
				continue
			}
			if _, collision := source.PublicHeaders[normalized]; collision {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			outbound.Header[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
		}
		for name, value := range source.PublicHeaders {
			outbound.Header.Set(name, value)
		}
		for name, value := range materials {
			outbound.Header.Set(name, value)
		}
		transport := upstream
		if transport == nil {
			transport = providerConnectionTransport(source)
		}
		client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("provider redirects are not allowed") }}
		response, err := client.Do(outbound)
		if err != nil || response == nil {
			c.AbortWithStatus(http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for name, values := range response.Header {
			normalized := strings.ToLower(name)
			if _, sensitive := providerAuthenticationHeaders[normalized]; sensitive {
				continue
			}
			if _, hop := providerHopByHopHeaders[normalized]; hop {
				continue
			}
			if normalized == "set-cookie" || normalized == "set-cookie2" {
				continue
			}
			for _, value := range values {
				c.Writer.Header().Add(name, value)
			}
		}
		c.Status(response.StatusCode)
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := response.Body.Read(buffer)
			if count > 0 {
				if _, writeErr := c.Writer.Write(buffer[:count]); writeErr != nil {
					break
				}
				c.Writer.Flush()
			}
			if readErr != nil {
				break
			}
		}
		c.Abort()
	}
}
