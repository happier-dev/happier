// Command happier-process-custody is the single first-party native helper behind
// SVC09's exact process-tree custody. It is a runtime support binary staged under
// `tools/unpacked` by the daemon-support payload builder; it is never a plugin
// contribution and never resolves anything on its own.
//
// Platforms:
//   - windows: `run --job=<name> -- <target...>` creates the named Job Object,
//     starts the target suspended, assigns it to the job before its first
//     instruction, resumes it, and waits. `terminate` / `query` act on a job by
//     name and prove full membership absence. Stdin/stdout/stderr and the
//     environment are the caller's, inherited unchanged by the target.
//   - darwin: `pid-startidentity <pid>` reports the native subsecond process
//     start identity (kinfo_proc p_starttime) via the numeric sysctl MIB
//     {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}. The parse is validated at
//     runtime and fails closed instead of guessing a layout.
//   - any other platform: every subcommand fails closed; Linux SVC09 custody
//     stays on its process-group owner and never consumes this helper.
//
// One JSON line goes to stdout for machine-readable outcomes; diagnostics go to
// stderr. Exit codes: 0 success, 2 usage, 3 custody outcome not proven, 4
// custody could not be established, 5 platform/OS error.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	exitOK            = 0
	exitUsage         = 2
	exitNotProven     = 3
	exitNotEstablished = 4
	exitOSError       = 5
)

// emit writes the one machine-readable outcome line for this invocation.
func emit(payload map[string]any) error {
	payload["v"] = 1
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(append(encoded, '\n'))
	return err
}

func usage() {
	fmt.Fprintln(os.Stderr, strings.TrimSpace(`
usage:
  happier-process-custody run --job=<name> -- <command> [args...]
  happier-process-custody terminate --job=<name> [--timeout-ms=<ms>]
  happier-process-custody query --job=<name>
  happier-process-custody pid-startidentity <pid>`))
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(exitUsage)
	}
	command, rest := args[0], args[1:]
	var err error
	switch command {
	case "run":
		err = runCustodyCommand(rest)
	case "terminate":
		err = terminateCustodyJob(rest)
	case "query":
		err = queryCustodyJob(rest)
	case "pid-startidentity":
		err = pidStartIdentityCommand(rest)
	default:
		usage()
		os.Exit(exitUsage)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "happier-process-custody:", err.Error())
		os.Exit(exitOSError)
	}
}
