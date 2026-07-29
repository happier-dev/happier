package managedruntime

import (
	"fmt"
	"path/filepath"
)

const ProcessConfigVersion = 1

type ProcessGatewayConfig struct {
	DownstreamBearer string             `json:"downstreamBearer"`
	RuntimeDir       string             `json:"runtimeDir"`
	AuthEntries      []AuthEntry        `json:"authEntries"`
	Protocols        []ProviderProtocol `json:"protocols"`
	ModelListEnabled bool               `json:"modelListEnabled"`
}

type ProcessConfig struct {
	V                   int                  `json:"v"`
	MaterializationID   string               `json:"materializationId"`
	WrapperBuildVersion string               `json:"wrapperBuildVersion"`
	Gateway             ProcessGatewayConfig `json:"gateway"`
	RequestAuth         HTTPBrokerConfig     `json:"requestAuth"`
}

func LoadProcessConfig(path string) (ProcessConfig, error) {
	if !filepath.IsAbs(path) {
		return ProcessConfig{}, fmt.Errorf("managed runtime config path must be absolute")
	}
	data, err := readBoundedPrivateFile(path, 512*1024)
	if err != nil {
		return ProcessConfig{}, fmt.Errorf("read managed runtime config: %w", err)
	}
	var config ProcessConfig
	if err := decodeStrictJSON(data, &config); err != nil {
		return ProcessConfig{}, fmt.Errorf("managed runtime config is invalid: %w", err)
	}
	if config.V != ProcessConfigVersion {
		return ProcessConfig{}, fmt.Errorf("managed runtime config version is unsupported")
	}
	if err := validateBoundedIdentity(
		config.MaterializationID,
		256,
		"materialization id",
	); err != nil {
		return ProcessConfig{}, fmt.Errorf(
			"managed runtime materialization identity is invalid: %w",
			err,
		)
	}
	if err := validateBoundedIdentity(
		config.WrapperBuildVersion,
		256,
		"wrapper build version",
	); err != nil {
		return ProcessConfig{}, fmt.Errorf(
			"managed runtime wrapper build version is invalid: %w",
			err,
		)
	}
	if err := config.Gateway.withEndpoint("127.0.0.1", 1).Validate(); err != nil {
		return ProcessConfig{}, fmt.Errorf("managed runtime gateway config is invalid: %w", err)
	}
	if _, err := NewHTTPBroker(config.RequestAuth); err != nil {
		return ProcessConfig{}, fmt.Errorf("managed runtime request-auth config is invalid: %w", err)
	}
	return config, nil
}

func (c ProcessGatewayConfig) withEndpoint(host string, port int) Config {
	return Config{
		Host:             host,
		Port:             port,
		DownstreamBearer: c.DownstreamBearer,
		RuntimeDir:       c.RuntimeDir,
		AuthEntries:      append([]AuthEntry(nil), c.AuthEntries...),
		Protocols:        append([]ProviderProtocol(nil), c.Protocols...),
		ModelListEnabled: c.ModelListEnabled,
	}
}

func (c ProcessGatewayConfig) ConfigForEndpoint(host string, port int) (Config, error) {
	config := c.withEndpoint(host, port)
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}
