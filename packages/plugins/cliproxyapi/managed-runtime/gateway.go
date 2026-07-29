package managedruntime

import (
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	WrapperContractVersion = "happier.cliproxyapi-managed/v1"
	PinnedSDKVersion       = "v7.2.95"
)

type Provider string

const (
	ProviderCodex  Provider = "codex"
	ProviderClaude Provider = "claude"
)

type ContributionIdentity struct {
	PluginID string `json:"pluginId"`
	LocalID  string `json:"localId"`
}

type QualifiedPurpose struct {
	Consumer ContributionIdentity `json:"consumer"`
	Purpose  string               `json:"purpose"`
}

type AuthEntry struct {
	ID       string           `json:"id"`
	Provider Provider         `json:"provider"`
	Purpose  QualifiedPurpose `json:"purpose"`
}

type Config struct {
	Host             string             `json:"host"`
	Port             int                `json:"port"`
	DownstreamBearer string             `json:"downstreamBearer"`
	RuntimeDir       string             `json:"runtimeDir"`
	AuthEntries      []AuthEntry        `json:"authEntries"`
	Protocols        []ProviderProtocol `json:"protocols"`
	ModelListEnabled bool               `json:"modelListEnabled"`
}

var (
	entryIDPattern             = regexp.MustCompile(`^[a-z0-9]+(?:[-/][a-z0-9]+)*$`)
	pluginIDSegmentPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	contributionLocalIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:[-/][a-z0-9]+)*$`)
)

func (c Config) Validate() error {
	ip := net.ParseIP(strings.TrimSpace(c.Host))
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("managed runtime host must be an explicit loopback IP")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("managed runtime port must be between 1 and 65535")
	}
	if c.DownstreamBearer == "" {
		return fmt.Errorf("downstream bearer is required")
	}
	if len(c.DownstreamBearer) > 128*1024 {
		return fmt.Errorf("downstream bearer is too large")
	}
	if !filepath.IsAbs(c.RuntimeDir) {
		return fmt.Errorf("runtime directory must be absolute")
	}
	if len(c.AuthEntries) == 0 {
		return fmt.Errorf("at least one authorized auth entry is required")
	}

	ids := make(map[string]struct{}, len(c.AuthEntries))
	providers := make(map[Provider]struct{}, len(c.AuthEntries))
	for i := range c.AuthEntries {
		entry := c.AuthEntries[i]
		if !entryIDPattern.MatchString(entry.ID) {
			return fmt.Errorf("auth entry %d has an invalid id", i)
		}
		if _, exists := ids[entry.ID]; exists {
			return fmt.Errorf("auth entry id %q is duplicated", entry.ID)
		}
		ids[entry.ID] = struct{}{}
		switch entry.Provider {
		case ProviderCodex, ProviderClaude:
		default:
			return fmt.Errorf("auth entry %q has unsupported provider %q", entry.ID, entry.Provider)
		}
		if _, exists := providers[entry.Provider]; exists {
			return fmt.Errorf("provider %q has more than one eligible managed auth entry", entry.Provider)
		}
		providers[entry.Provider] = struct{}{}
		if err := entry.Purpose.validate(); err != nil {
			return fmt.Errorf("auth entry %q purpose: %w", entry.ID, err)
		}
	}

	if len(c.Protocols) == 0 {
		return fmt.Errorf("at least one Provider protocol is required")
	}
	if _, err := servingRoutesForProtocols(c.Protocols, c.ModelListEnabled); err != nil {
		return err
	}
	return nil
}

func (p QualifiedPurpose) validate() error {
	if err := p.Consumer.validate(); err != nil {
		return fmt.Errorf("consumer: %w", err)
	}
	purpose := strings.TrimSpace(p.Purpose)
	if p.Purpose != purpose || purpose == "" || len(purpose) > 128 {
		return fmt.Errorf("purpose id must contain 1 to 128 characters")
	}
	return nil
}

func (identity ContributionIdentity) validate() error {
	if identity.PluginID != strings.TrimSpace(identity.PluginID) || !validPluginID(identity.PluginID) {
		return fmt.Errorf("plugin id is invalid")
	}
	if identity.LocalID != strings.TrimSpace(identity.LocalID) ||
		!contributionLocalIDPattern.MatchString(identity.LocalID) {
		return fmt.Errorf("local id is invalid")
	}
	return nil
}

func validPluginID(value string) bool {
	if value == "" || value == "." || value == ".." ||
		strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") ||
		strings.ContainsAny(value, `/\`) {
		return false
	}
	segments := strings.Split(value, ".")
	if len(segments) < 2 {
		return false
	}
	for _, segment := range segments {
		if segment == "__proto__" || segment == "constructor" || segment == "prototype" ||
			!pluginIDSegmentPattern.MatchString(segment) {
			return false
		}
	}
	return true
}
