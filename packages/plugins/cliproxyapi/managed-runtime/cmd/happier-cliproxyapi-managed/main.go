package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

var buildVersion = "dev"

func main() {
	if err := run(os.Args[1:], os.LookupEnv); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "managed CLIProxyAPI wrapper %s: %v\n", buildVersion, err)
		os.Exit(2)
	}
}

func run(args []string, lookupEnvironment func(string) (string, bool)) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runWithContext(ctx, args, lookupEnvironment)
}

func runWithContext(
	ctx context.Context,
	args []string,
	lookupEnvironment func(string) (string, bool),
) error {
	if err := parseArguments(args); err != nil {
		return err
	}
	gatewayConfig, brokerConfig, err := materializeGatewayConfig(lookupEnvironment)
	if err != nil {
		return err
	}
	broker, err := managedruntime.NewHTTPBroker(brokerConfig)
	if err != nil {
		return err
	}
	gateway, err := managedruntime.NewGateway(
		gatewayConfig,
		managedruntime.RuntimeIdentity{
			WrapperBuildVersion: buildVersion,
		},
		broker,
		nil,
	)
	if err != nil {
		return err
	}

	err = gateway.Run(ctx)
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return nil
	}
	return err
}

func parseArguments(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: happier-cliproxyapi-managed")
	}
	return nil
}

func materializeGatewayConfig(
	lookupEnvironment func(string) (string, bool),
) (managedruntime.Config, managedruntime.HTTPBrokerConfig, error) {
	host, hasHost := lookupEnvironment("HOST")
	if !hasHost || host == "" || host != strings.TrimSpace(host) {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("SVC09 HOST is missing or invalid")
	}
	rawPort, hasPort := lookupEnvironment("PORT")
	if !hasPort || rawPort == "" || rawPort != strings.TrimSpace(rawPort) {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("SVC09 PORT is missing or invalid")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("SVC09 PORT is invalid")
	}
	downstreamBearer, err := requiredEnvironment(
		lookupEnvironment,
		managedruntime.DownstreamBearerEnvironmentVariable,
	)
	if err != nil {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, err
	}
	capabilityPath, err := requiredEnvironment(
		lookupEnvironment,
		managedruntime.RequestAuthCapabilityPathEnvironmentVariable,
	)
	if err != nil || !filepath.IsAbs(capabilityPath) || strings.ContainsRune(capabilityPath, '\x00') {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("managed request-auth capability environment is missing or invalid")
	}
	purposeConfigurationValue, err := requiredEnvironment(
		lookupEnvironment,
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable,
	)
	if err != nil {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("managed purpose configuration environment is missing or invalid")
	}
	purposeConfiguration, err := managedruntime.ParseManagedPurposeConfiguration(
		purposeConfigurationValue,
	)
	if err != nil {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("managed purpose configuration environment is invalid")
	}
	capabilityPath = filepath.Clean(capabilityPath)
	runtimeDir := filepath.Dir(filepath.Dir(capabilityPath))
	if runtimeDir == filepath.Dir(runtimeDir) {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("managed request-auth capability environment is missing or invalid")
	}
	config, err := managedruntime.ImmutableGatewayConfig(
		host,
		port,
		downstreamBearer,
		runtimeDir,
		purposeConfiguration,
	)
	if err != nil {
		return managedruntime.Config{}, managedruntime.HTTPBrokerConfig{}, fmt.Errorf("managed gateway environment is invalid: %w", err)
	}
	return config, managedruntime.HTTPBrokerConfig{
		CapabilityPath: capabilityPath,
	}, nil
}

func requiredEnvironment(
	lookupEnvironment func(string) (string, bool),
	name string,
) (string, error) {
	value, ok := lookupEnvironment(name)
	if !ok || value == "" || value != strings.TrimSpace(value) {
		return "", fmt.Errorf("managed process environment is missing or invalid")
	}
	return value, nil
}
