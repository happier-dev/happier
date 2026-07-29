package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if err := run(os.Args[1:], os.LookupEnv, os.Stdout); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "managed CLIProxyAPI wrapper %s: %v\n", buildVersion, err)
		os.Exit(2)
	}
}

func run(args []string, lookupEnvironment func(string) (string, bool), stdout io.Writer) error {
	configPath, err := parseConfigPath(args)
	if err != nil {
		return err
	}
	processConfig, err := managedruntime.LoadProcessConfig(configPath)
	if err != nil {
		return err
	}
	if err := validateWrapperBuildVersion(
		processConfig.WrapperBuildVersion,
		buildVersion,
	); err != nil {
		return err
	}
	gatewayConfig, err := materializeGatewayConfig(processConfig.Gateway, lookupEnvironment)
	if err != nil {
		return err
	}
	broker, err := managedruntime.NewHTTPBroker(processConfig.RequestAuth)
	if err != nil {
		return err
	}
	gateway, err := managedruntime.NewGateway(
		gatewayConfig,
		managedruntime.RuntimeIdentity{
			WrapperBuildVersion: buildVersion,
			MaterializationID:   processConfig.MaterializationID,
		},
		broker,
		nil,
	)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runResult := make(chan error, 1)
	go func() {
		runResult <- gateway.Run(ctx)
	}()

	select {
	case readiness := <-gateway.Ready():
		if err := json.NewEncoder(stdout).Encode(readiness); err != nil {
			stop()
			<-runResult
			return fmt.Errorf("write managed runtime readiness: %w", err)
		}
		err := <-runResult
		if errors.Is(err, context.Canceled) && ctx.Err() != nil {
			return nil
		}
		return err
	case err := <-runResult:
		if errors.Is(err, context.Canceled) && ctx.Err() != nil {
			return nil
		}
		if err == nil {
			return fmt.Errorf("managed gateway exited before readiness")
		}
		return err
	}
}

func validateWrapperBuildVersion(configured, compiled string) error {
	if configured == "" || compiled == "" || configured != compiled {
		return fmt.Errorf(
			"managed runtime wrapper build identity mismatch: config=%q binary=%q",
			configured,
			compiled,
		)
	}
	return nil
}

func parseConfigPath(args []string) (string, error) {
	if len(args) != 2 || args[0] != "--config" || strings.TrimSpace(args[1]) != args[1] ||
		!filepath.IsAbs(args[1]) {
		return "", fmt.Errorf("usage: happier-cliproxyapi-managed --config <absolute-private-config-path>")
	}
	return filepath.Clean(args[1]), nil
}

func materializeGatewayConfig(
	input managedruntime.ProcessGatewayConfig,
	lookupEnvironment func(string) (string, bool),
) (managedruntime.Config, error) {
	host, hasHost := lookupEnvironment("HOST")
	if !hasHost || host == "" || host != strings.TrimSpace(host) {
		return managedruntime.Config{}, fmt.Errorf("SVC09 HOST is missing or invalid")
	}
	rawPort, hasPort := lookupEnvironment("PORT")
	if !hasPort || rawPort == "" || rawPort != strings.TrimSpace(rawPort) {
		return managedruntime.Config{}, fmt.Errorf("SVC09 PORT is missing or invalid")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return managedruntime.Config{}, fmt.Errorf("SVC09 PORT is invalid")
	}
	config, err := input.ConfigForEndpoint(host, port)
	if err != nil {
		return managedruntime.Config{}, fmt.Errorf("SVC09 endpoint is invalid: %w", err)
	}
	return config, nil
}
