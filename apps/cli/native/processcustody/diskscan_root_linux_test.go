//go:build linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDiskScanRootMountEligibility(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		fsType int64
		flags  int64
		reason string
		resume bool
	}{
		{name: "writable", fsType: unix.EXT4_SUPER_MAGIC},
		{name: "read-only", fsType: unix.EXT4_SUPER_MAGIC, flags: unix.ST_RDONLY, reason: "read_only_filesystem"},
		{name: "system", fsType: unix.PROC_SUPER_MAGIC, reason: "pseudo_or_cloud_filesystem"},
		{name: "read-only-resume", fsType: unix.EXT4_SUPER_MAGIC, flags: unix.ST_RDONLY, reason: "read_only_filesystem", resume: true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "ordinary-file")
			if err := os.WriteFile(file, []byte("allocated storage"), 0600); err != nil {
				t.Fatal(err)
			}
			original := diskReadMountFacts
			// Only the OS mount observation is controlled; the native stream,
			// filesystem metadata, enumeration and accounting remain real.
			diskReadMountFacts = func(path string, fs *unix.Statfs_t) error {
				if err := unix.Statfs(path, fs); err != nil {
					return err
				}
				if diskPathContains(root, path) {
					fs.Type, fs.Flags = fixture.fsType, fixture.flags
				}
				return nil
			}
			t.Cleanup(func() { diskReadMountFacts = original })
			request := diskScanRequest{Root: root, ScratchDirectory: t.TempDir()}
			if fixture.resume {
				request.ResumeFrom = []string{root}
			}
			var summary diskSummary
			var records, entries int
			foundFile := false
			err := diskScanStream(context.Background(), &diskControl{skipped: map[string]bool{}}, request, func(value any) error {
				switch record := value.(type) {
				case diskDirRecord:
					records++
				case diskEntryRecord:
					entries++
					foundFile = foundFile || record.Node.ID == diskPathID(file)
				case diskSummary:
					summary = record
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if fixture.reason == "" {
				if !foundFile || summary.Items < 2 || len(summary.Skipped) != 0 {
					t.Fatalf("writable root was not scanned: file=%v summary=%+v", foundFile, summary)
				}
				return
			}
			if records != 0 || entries != 0 || summary.Items != 0 || summary.AllocatedBytes != 0 {
				t.Fatalf("ineligible root was enumerated: records=%d entries=%d summary=%+v", records, entries, summary)
			}
			if summary.Termination != "completed" || len(summary.Skipped) != 1 || summary.Skipped[0] != (diskIssue{diskPathID(root), fixture.reason}) {
				t.Fatalf("mount eligibility reason missing: %+v", summary)
			}
		})
	}
}
