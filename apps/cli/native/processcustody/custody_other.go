//go:build !windows && !darwin

// Platform guard. Linux SVC09 custody is owned by the dedicated process-group
// path (detached group leader + group liveness probe) and never consumes this
// helper, so on any other platform every subcommand fails closed rather than
// pretending to a containment it cannot provide.
package main

import "fmt"

func unsupportedPlatform() error {
	return fmt.Errorf("happier-process-custody provides no custody on this platform")
}

func runCustodyCommand(args []string) error {
	return unsupportedPlatform()
}

func terminateCustodyJob(args []string) error {
	return unsupportedPlatform()
}

func queryCustodyJob(args []string) error {
	return unsupportedPlatform()
}

func pidStartIdentityCommand(args []string) error {
	return unsupportedPlatform()
}
