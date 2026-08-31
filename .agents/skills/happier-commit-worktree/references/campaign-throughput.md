# Campaign Throughput and Parallel Execution

## Contents

1. Completion contract
2. Rolling-wave pipeline
3. Confidence lanes
4. Parallel topology
5. Reconnaissance lane contract
6. Packet queue
7. Validation batching
8. Moving-worktree refresh
9. Progress and liveness gates
10. Compaction anchor and stopping rules

## 1. Completion contract

A large-worktree commit request is a campaign. Unless the user pauses or narrows scope, continue until every current path is one of:

- committed in a coherent packet;
- an evidenced artifact or intentional exclusion;
- unresolved after the smallest meaningful evidence search, with the missing fact and next deciding observation named;
- blocked by a real authority, collision, failing owner behavior, or unavailable external prerequisite.

One commit, one domain, one subagent response, or one wave is never implicit completion. If valid source paths remain, return to reconnaissance and prepare the next packets in the same turn whenever feasible.

## 2. Rolling-wave pipeline

Avoid both extremes: exhaustive analysis of thousands of paths before the first commit, and one-packet-at-a-time recon that leaves the commit authority idle.

Use this pipeline:

1. Snapshot HEAD, index, status counts, and grouped paths.
2. Partition independent domains and start parallel reconnaissance.
3. Prepare a queue of 5-15 coherent packets when scope permits.
4. Validate independent packets concurrently.
5. Drain ready packets through one serial private-index/CAS authority.
6. Re-snapshot at the wave boundary.
7. Refresh newly landed, overlapping, or invalidated paths only.
8. Repeat until the completion contract holds.

The packet range is a queue-depth heuristic, not a commit quota. A small residual campaign may have fewer packets; a large campaign should normally keep more than one packet ready.

## 3. Confidence lanes

### Green: commit-ready

- intent and owner are evident from the diff and nearby code;
- required siblings and tests are known;
- provenance is source-controlled and non-artifactual;
- no incompatible overlap or unexplained mixed hunk remains.

Prepare, validate, and commit without waiting for yellow or red work.

### Yellow: targeted investigation

- likely valid source work, but ownership, grouping, test deletion, generated provenance, or one dependency is unclear;
- one or two focused searches, history queries, or owner comparisons should decide it.

Investigate concurrently. Promote to green or demote to red with evidence.

### Red: exclude or genuinely block

- temporary, generated, QA, evidence, cache, build, secret, oversized, or explicitly non-shipping material;
- dormant production mechanism with no live consumer or defining test;
- destructive coverage deletion, conflicting intent, or ambiguous provenance not safely resolvable from current evidence.

Red paths stay uncommitted. They do not block unrelated green packets.

## 4. Parallel topology

Parallelize work that does not mutate the same authority:

- grouped status and diff inspection;
- symbol/caller/test/history searches;
- artifact and provenance analysis;
- candidate packet manifests and messages;
- independent focused tests and package checks when resource capacity permits;
- post-commit inspection while later disjoint packets are prepared.

Serialize by default:

- final coherence and ownership adjudication;
- private-index packet assembly;
- commit object creation and CAS update of HEAD;
- exact shared-index synchronization;
- collision recovery for overlapping paths.

Private indexes isolate staging, not HEAD history. Multiple commit writers are useful only when lanes are genuinely disjoint, each writer implements stale-parent rebuild correctly, and retries cost less than serial attachment. Prefer one commit authority with a continuously supplied queue.

Keep at least one wave of commit-ready packets prepared ahead whenever valid unclassified paths remain. An idle commit authority while independent reconnaissance could be running is an execution-efficiency defect.

## 5. Reconnaissance lane contract

Give each lane a self-contained brief with:

- exact assigned paths or a deterministic scoped inventory command;
- goal and bounded domain;
- current HEAD and acknowledgement that the worktree is moving;
- required output schema;
- forbidden mutations and artifact policy;
- expected validation and stop conditions.

Require the lane to process its inventory to exhaustion. Its result accounts for every assigned path as:

1. a commit-ready packet with exact paths/hunks, intent, owner, dependencies, subject, body, and validation;
2. an exclusion with observed evidence;
3. an unresolved path with the exact missing fact and deciding observation.

Reject responses that provide examples, themes, representative groups, or a partial list without accounting for the remainder. Do not ask every lane to repeat global repository doctrine; reference this skill and include only task-local evidence.

## 6. Packet queue

Keep a compact in-memory queue. Each packet records:

- specific outcome or invariant;
- canonical owner and materially coupled consumers/tests;
- exact whole paths and partial-hunk instructions;
- dependency order;
- confidence lane;
- Conventional Commit subject and explanatory body;
- focused validation and reusable wave checks;
- collision or artifact concerns.

Prepare messages with the packet rather than after staging. The orchestrator verifies the current bytes before committing; it does not blindly trust delegated manifests.

Drain packets in dependency order. If a packet becomes stale because HEAD or its worktree paths changed, refresh only that packet and affected dependents. Continue draining unaffected packets.

## 7. Validation batching

Do not serialize checks that can safely run together, and do not repeat identical broad checks for every commit.

- Run behavior-discriminating focused tests for the packet when available.
- Run one package typecheck/build or broader suite after a compatible wave.
- Record the path/corridor basis covered by shared validation.
- Reuse that evidence until later bytes touch the deciding corridor.
- Avoid concurrent heavyweight suites when the machine is already resource-saturated.
- When infrastructure is known to terminate or hang a check, preserve the evidence, continue unrelated packets, and retry once at a useful boundary rather than spawning repeated doomed campaigns.

Validation batching never permits claiming an unrun check passed or hiding a packet-caused failure.

## 8. Moving-worktree refresh

At a wave boundary:

1. capture current HEAD and shared-index state;
2. compare current grouped status with the prior inventory;
3. identify newly landed paths, residual hunks in committed files, and paths changed during recon;
4. retain still-valid disjoint packet analysis;
5. refresh only affected packets and dependencies.

Do not restart a full repository analysis merely because HEAD advanced through the campaign's own commits. Do not assume an old manifest still describes current bytes when one of its paths changed.

## 9. Progress and liveness gates

At each wave boundary record:

- starting and remaining path counts;
- paths consumed by commits;
- commits created and current HEAD;
- green queue depth;
- yellow and red counts;
- next prepared packets;
- validation completed, failed, or unavailable.

Use these liveness checks:

- Many valid paths remain and green queue is empty: reconnaissance is incomplete; start or broaden lanes.
- Commit authority is idle while independent recon can run: parallelization is insufficient.
- Repeated one-file commits share one intent: grouping is too narrow; rebuild the packet.
- A large packet needs vague message clauses: grouping is too broad; split it.
- Yellow paths remain unexamined while agents stop: evidence work is incomplete.
- Only red paths remain with exact reasons: proceed to residual closeout.

Optimize path reduction and resolved intent, not raw commit count.

## 10. Compaction anchor and stopping rules

Every continuation or compaction handoff preserves:

- campaign starting parent;
- current HEAD and clean/dirty shared-index status;
- completed commit ids and outcomes;
- remaining counts grouped by domain;
- ready packet queue and dependency order;
- exclusions and unresolved paths with evidence;
- validation constraints and known infrastructure failures;
- exact next action.

Resume from this anchor and live Git state. Do not repeat completed commits or restart broad recon unless the basis materially changed.

Valid stopping conditions are limited to:

- every current path satisfies the completion contract;
- the user explicitly pauses or changes scope;
- all remaining work is genuinely blocked and independent progress is exhausted.

Do not stop because a wave finished, a lane returned, a domain was completed, context is nearing compaction, tests are saturated, or some uncertain paths exist alongside ready work.
