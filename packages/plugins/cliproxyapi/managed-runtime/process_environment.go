package managedruntime

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const (
	DownstreamBearerEnvironmentVariable            = "HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER"
	RequestAuthCapabilityPathEnvironmentVariable   = "HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH"
	ManagedPurposeConfigurationEnvironmentVariable = "HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION"
)

const managedPurposeConfigurationMaxBytes = 4096

type ManagedPurposeConfiguration struct {
	V                int                              `json:"v"`
	ModelListEnabled bool                             `json:"modelListEnabled"`
	Purposes         []ManagedPurposeConfigurationRow `json:"purposes"`
}

type managedPurposeConfigurationWire struct {
	V                int                              `json:"v"`
	ModelListEnabled *bool                            `json:"modelListEnabled"`
	Purposes         []ManagedPurposeConfigurationRow `json:"purposes"`
}

// ManagedPurposeConfigurationRow is a non-secret selected purpose family
// serialized by the plugin-local managed-family contract. The wrapper only
// validates and consumes the exact selected rows; it does not keep a second
// purpose-to-provider or purpose-to-protocol table.
type ManagedPurposeConfigurationRow struct {
	ID                 string               `json:"id"`
	Provider           Provider             `json:"provider"`
	Consumer           ContributionIdentity `json:"consumer"`
	Purpose            string               `json:"purpose"`
	AllowedHTTPSOrigin string               `json:"allowedHttpsOrigin"`
	Protocols          []ProviderProtocol   `json:"protocols"`
}

// ParseManagedPurposeConfiguration accepts only the non-secret, host-created
// launch snapshot. Credentials stay in request-auth and never enter this
// process configuration.
func ParseManagedPurposeConfiguration(value string) (ManagedPurposeConfiguration, error) {
	if value == "" || value != strings.TrimSpace(value) || len(value) > managedPurposeConfigurationMaxBytes {
		return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader([]byte(value)))
	decoder.DisallowUnknownFields()
	var wire managedPurposeConfigurationWire
	if err := decoder.Decode(&wire); err != nil || wire.ModelListEnabled == nil {
		return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
	}
	return normalizeManagedPurposeConfiguration(ManagedPurposeConfiguration{
		V:                wire.V,
		ModelListEnabled: *wire.ModelListEnabled,
		Purposes:         wire.Purposes,
	})
}

// ImmutableGatewayConfig combines the process-specific endpoint and private
// material with one exact non-secret bound-purpose snapshot supplied by the
// managed Provider runtime before child supervision.
func ImmutableGatewayConfig(
	host string,
	port int,
	downstreamBearer string,
	runtimeDir string,
	purposeConfiguration ManagedPurposeConfiguration,
) (Config, error) {
	normalizedPurposeConfiguration, err := normalizeManagedPurposeConfiguration(
		purposeConfiguration,
	)
	if err != nil {
		return Config{}, err
	}
	authEntries := make([]AuthEntry, 0, len(normalizedPurposeConfiguration.Purposes))
	protocols := make([]ProviderProtocol, 0, len(normalizedPurposeConfiguration.Purposes)*2)
	for _, row := range normalizedPurposeConfiguration.Purposes {
		authEntries = append(authEntries, AuthEntry{
			ID:                 row.ID,
			Provider:           row.Provider,
			Purpose:            QualifiedPurpose{Consumer: row.Consumer, Purpose: row.Purpose},
			AllowedHTTPSOrigin: row.AllowedHTTPSOrigin,
		})
		protocols = append(protocols, row.Protocols...)
	}
	config := Config{
		Host:             host,
		Port:             port,
		DownstreamBearer: downstreamBearer,
		RuntimeDir:       runtimeDir,
		AuthEntries:      authEntries,
		Protocols:        protocols,
		ModelListEnabled: normalizedPurposeConfiguration.ModelListEnabled,
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func normalizeManagedPurposeConfiguration(
	configuration ManagedPurposeConfiguration,
) (ManagedPurposeConfiguration, error) {
	if configuration.V != 2 || len(configuration.Purposes) == 0 || len(configuration.Purposes) > 8 {
		return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
	}
	seenIDs := make(map[string]struct{}, len(configuration.Purposes))
	seenProviders := make(map[Provider]struct{}, len(configuration.Purposes))
	seenPurposes := make(map[QualifiedPurpose]struct{}, len(configuration.Purposes))
	seenProtocols := make(map[ProviderProtocol]struct{}, len(configuration.Purposes)*2)
	purposes := make([]ManagedPurposeConfigurationRow, 0, len(configuration.Purposes))
	for _, row := range configuration.Purposes {
		entry := AuthEntry{
			ID:                 row.ID,
			Provider:           row.Provider,
			Purpose:            QualifiedPurpose{Consumer: row.Consumer, Purpose: row.Purpose},
			AllowedHTTPSOrigin: row.AllowedHTTPSOrigin,
		}
		if err := entry.validate(); err != nil || len(row.Protocols) == 0 {
			return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
		}
		if _, exists := seenIDs[row.ID]; exists {
			return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
		}
		seenIDs[row.ID] = struct{}{}
		if _, exists := seenProviders[row.Provider]; exists {
			return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
		}
		seenProviders[row.Provider] = struct{}{}
		if _, exists := seenPurposes[entry.Purpose]; exists {
			return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
		}
		seenPurposes[entry.Purpose] = struct{}{}
		protocols := make([]ProviderProtocol, 0, len(row.Protocols))
		for _, protocol := range row.Protocols {
			if _, exists := protocolSurfaces[protocol]; !exists {
				return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
			}
			if _, exists := seenProtocols[protocol]; exists {
				return ManagedPurposeConfiguration{}, fmt.Errorf("managed purpose configuration is invalid")
			}
			seenProtocols[protocol] = struct{}{}
			protocols = append(protocols, protocol)
		}
		purposes = append(purposes, ManagedPurposeConfigurationRow{
			ID:                 row.ID,
			Provider:           row.Provider,
			Consumer:           row.Consumer,
			Purpose:            row.Purpose,
			AllowedHTTPSOrigin: row.AllowedHTTPSOrigin,
			Protocols:          protocols,
		})
	}
	return ManagedPurposeConfiguration{
		V:                2,
		ModelListEnabled: configuration.ModelListEnabled,
		Purposes:         purposes,
	}, nil
}
