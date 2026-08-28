# Massive Campaigns and Delegation

## Contents

1. When massive mode applies
2. Obtaining and retaining sizing authority
3. Scaling coherence beyond one thousand paths
4. Filesystem-preserving safety
5. Generated-output and publisher ownership
6. Branch and upstream handoff
7. Durable delegation anchor

## 1. When massive mode applies

Massive mode is a throughput posture for an unusually large commit campaign, not permission to create miscellaneous dump commits. Use it when either:

- the user explicitly asks for much larger commits, rapid bulk committing, or completion of a worktree containing hundreds or thousands of paths; or
- reconnaissance finds more than 1,000 current changed or untracked paths and the user has not yet selected a sizing posture.

The path count is a decision trigger, not a grouping rule. A campaign with 3,000 paths may yield several 100-500-path commits for uniform migrations, generated publications, locale matrices, SDK surfaces, or test-harness fan-out, alongside much smaller behavior commits. Each packet must still satisfy the coherence tests in [grouping-and-messages.md](grouping-and-messages.md).

## 2. Obtaining and retaining sizing authority

If more than 1,000 current paths exist and the user has not already approved larger commits in the current campaign or durable handoff, ask one concise question before creating the first massive packet:

> This worktree has approximately N changed paths. Should I use large coherent packets—including 100+ files when one migration, generated closure, locale matrix, or subsystem vertical supports it—or keep ordinary review-sized commits?

Continue read-only reconnaissance while waiting when it cannot prejudge the answer. Do not stage or commit a massive packet until the choice is known.

Treat a clear answer such as "use much bigger commits," "commit as much as possible," or "continue with big commits" as campaign-level approval. Preserve it in every compaction and delegation anchor. Do not ask again merely because the session continued, context compacted, HEAD advanced, or another agent resumed. Ask again only when:

- the user narrows or reverses the preference;
- the proposed packet crosses a materially different boundary, such as combining independent products instead of enlarging one coherent program;
- a generated/vendor/binary publication has unusual review, size, ownership, or release consequences not covered by the prior approval; or
- the handoff does not establish whether large-packet authority was granted.

When the user has not answered and fewer than 1,000 paths exist, use the ordinary coherence-first sizing rules without asking a preference question unless two materially different grouping strategies remain equally plausible.

## 3. Scaling coherence beyond one thousand paths

Build larger packets by widening a proven semantic boundary, not by concatenating ready commits. Suitable massive packets include:

- one end-to-end subsystem vertical: contract, canonical owner, adapters, consumers, defining tests, fixtures, localization, and narrowly coupled documentation;
- one uniform repository-wide migration with the same transformation and rollback story;
- one provider/backend/platform matrix implementing the same contract;
- one canonical generated publication closure produced from the same source change and publisher run;
- one locale or catalog matrix whose entries express the same product change;
- one test-harness or fixture migration required by the same runtime contract.

Before accepting a 100+ path packet, partition its manifest by domain and role and prove:

1. one subject can name the outcome without "miscellaneous," "remaining," or a list of unrelated features;
2. every subgroup has the same reversion reason;
3. no subgroup can be independently reverted without weakening the claimed outcome;
4. generated output has one established producer/currentness event;
5. unrelated formatting, artifacts, dormant code, and destructive coverage reductions are absent;
6. the body can explain the broad scope in a few precise paragraphs.

If those tests fail, split by canonical owner, product outcome, migration phase, provider family, publication event, or independently revertible behavior. Do not fall back to directory-size buckets. If two groupings both look defensible and the choice materially affects review or rollback, give the user the two short options and recommend one.

Massive mode should improve campaign throughput. Avoid spending more time proving an artificial mega-commit than it would take to publish two or three clearly coherent large commits.

## 4. Filesystem-preserving safety

The filesystem is authoritative for the bytes the user wants preserved. The shared index is evidence and staging state, never the desired source of truth. This does not mean every filesystem path should be committed: suitability still requires provenance, ownership, and coherence.

At campaign start and every wave boundary, separately inventory:

- tracked worktree modifications and deletions;
- untracked files, expanding directories to exact paths;
- shared-index additions, modifications, deletions, and conflicts;
- HEAD, branch, upstream, relevant reflog movement, and active Git locks;
- tracked or staged paths beneath forbidden local-state directories such as `.project`.

Never repair an index anomaly by writing index or HEAD bytes back to the worktree. Never use `reset`, `restore`, `checkout`, `switch`, `clean`, or broad index reconstruction. Diagnose HEAD, index, and filesystem independently, then repair only exact known index entries after preserving inherited staged intent.

For deletions, prove the path is absent on disk and that the deletion belongs to the packet. A staged deletion for a path that exists on disk is an index anomaly until proven otherwise. A path absent on disk but present in HEAD is not automatically an intentional deletion; inspect callers, history, replacement paths, and neighboring tests.

Do not create locks, manifests, patches, messages, or campaign state inside `.project`. Store an optional serialization lock beneath `git rev-parse --git-common-dir`, and keep temporary manifests and messages outside the repository. CAS remains mandatory even when a lock is used.

After a massive commit advances HEAD, synchronize the entire selected manifest through the private-index protocol's single deletion-aware batch update. Never acquire and release the shared index lock once per path for a 100+ path packet; that leaves a misleading partially staged state for too long and magnifies collision risk.

## 5. Generated-output and publisher ownership

Distinguish committing stable generated bytes from running a mutating publisher. Declaration, API, distribution, package, registry, and release generation commonly writes overlapping paths and must have one explicit owner.

Before running or capturing generated output:

1. identify the canonical generator and tracked-output contract;
2. determine whether another process or session owns the publisher;
3. inspect relevant locks, processes, and modification-time stability;
4. do not start a second mutating aggregate while ownership is active;
5. continue independent non-publisher source packets where safe;
6. after ownership is released, refresh the full generated closure from current bytes and current HEAD.

An earlier request for large commits does not authorize starting a publisher, overwriting generated bytes, or publishing packages. Those actions require the authority already implied by the user's task or a separate explicit request.

## 6. Branch and upstream handoff

Committing does not imply authority to rename a branch, change its upstream, or push. Perform those actions only when explicitly requested.

Before a branch rename or push:

- confirm current branch, HEAD, worktree/index state, upstream, and remote target;
- verify the target branch/ref situation rather than assuming it is unused;
- after a rename, inspect whether Git retained an obsolete upstream and unset or replace it only as authorized;
- never push merely because the branch was renamed;
- after another writer pushes or advances HEAD, refresh from the live basis and discard stale private indexes.

## 7. Durable delegation anchor

A handoff to another session must be self-contained and must not depend on `/tmp` manifests or collapsed commentary. Record:

- absolute repository path and any execution projection needed to reach it;
- campaign starting parent, current branch, HEAD, upstream, and divergence;
- configured commit identity and any packet-specific verified co-authors;
- explicit commit authorization and whether massive-packet authority was granted;
- validation posture, including an explicit user waiver when tests/builds/generators are skipped;
- current tracked, deleted, untracked, conflicted, and staged counts;
- whether `.project` has any tracked or staged paths;
- active Git locks, publisher owner, generated-output exclusions, and concurrent writers;
- completed commit ids/outcomes and current residual groups;
- ready packet manifests described in durable prose, with exact next action;
- forbidden operations, branch/push authority, and every evidence-backed exclusion.

The receiving agent must read the skill and relevant references, inspect live Git state, and reconcile it with the anchor before mutating anything. It must rebuild ephemeral private indexes and manifests from current HEAD/current filesystem bytes rather than trusting artifacts from the previous session.
