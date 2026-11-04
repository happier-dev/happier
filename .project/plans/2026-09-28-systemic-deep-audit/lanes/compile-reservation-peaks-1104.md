VERIFIED_COMPLETE — General compilation reservation raised from 26 to 38 GiB; focused checks and entry loads passed. Private-index commit recorded in the finalizer log below.

Observed evidence and attribution:
- Original 32 compiler samples: `.project/tmp/systemic-orch/tsc-peaks-2154-2219.tsv`.
  The 36.4 GiB maximum has no retained admission-class attribution; it was not assigned by argv.
- Broker acquire requests carry `className`, but settled slots retain PID and floor only:
  `apps/stack/scripts/utils/proc/admission_broker.mjs` and `admission_socket.mjs`.
  Aggregate status exposes no class/holder history; no new recording mechanism was added.
- Smallest additional measurement: one read-only snapshot of existing admitted holders,
  their descendants' `/proc/PID/status`, and `/proc/meminfo`; no compiler was launched.
  Evidence: `.project/tmp/compile-reservation-peaks-1104/holder-snapshot.json`.
- Holder 2355054 reserved 27,262,976 KiB (26 GiB). Its tree used 38,992,620 KiB
  simultaneously (37.1863 GiB); descendant 1207465 retained VmHWM 36,597,668 KiB
  and matches the original 34.9 GiB compiler sample.
- Derived class: the recorded 26 GiB floor uniquely matched `compilation` in the
  pre-change canonical catalog. There is no explicit retained class field per holder.
  This attribution uses admission's reservation and ancestry, never process arguments.

Class comparison and change:
| Class | Previous GiB | Attributable measurement | New GiB |
| --- | ---: | --- | ---: |
| compilation | 26 | 37.1863 GiB simultaneous holder-tree RSS | 38 |
| compilation-ui | 20 | None in these samples | 20 |
| compilation-cli | 15 | None in these samples | 15 |
| compilation-server | 16 | None in these samples | 16 |

- 38 = ceil(38,992,620 / 1,048,576), with no margin. No class was lowered or split.
- The catalog already documents multi-package CLI + UI commit coherence as general
  compilation. This holder's exact workload scope is unknown without argv; no claim
  is made that its size came from coherence. `coherence-scope-1104` can consume this
  holder/peak evidence while narrowing its own checker; this lane did not change it.
- Derived capacity at observed MemTotal 263,378,424 KiB (251.177 GiB): homogeneous
  general-compilation theoretical maximum changes floor(251.177/26)=9 to
  floor(251.177/38)=6. Other memory use reduces actual admission capacity further.

Owner, verification and commit:
- Canonical owner: `apps/stack/scripts/utils/dev_targets/command_resources.mjs`.
  JavaScript policy and generated `native_command_policy.sh` consume that catalog;
  the native shell projection was regenerated. Existing package-specific classes remain.
- Constructed RED: measured-reservation test failed actual 27,262,976 versus expected
  39,845,888 KiB; `.project/tmp/compile-reservation-peaks-1104/red.log` (exit 1).
- GREEN: 10/10 focused tests, including native catalog projection parity and unchanged
  package-specific envelopes; `green.log` under the same evidence directory (exit 0).
- Entry loads: all reported graphs passed; `entry-loads.log` in that directory (exit 0).
- Full package/build lanes intentionally omitted under this brief's commits-first scope.
- Private-index finalizer and committed packet: `commit.log` in that directory; ordinary
  configured machine identity, own hunks only, no push and no shared-index staging.
- Net mechanism delta: checks/states/errors/timers/retries/classes +0 / -0; one existing
  reservation recalibrated, three source/projection/test files modified, one report added.
  Broker ordering, admission lifecycle, databases, and checker behavior were not changed.

Residual risk: one live snapshot establishes a lower bound, not a universal maximum.
Historical peaks cannot recalibrate package-specific classes without holder attribution;
their existing reservations remain unverified by these samples. Loaded long-lived shells
may retain their previous projection until their existing natural reload boundary.
