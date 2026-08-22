---
name: happier-slopo
description: Run and interpret Slopo duplicate-implementation scans in Happier production source when reviewing split-brains, repeated plugin/runtime mechanisms, or consolidation opportunities. Use it as advisory evidence within happier-review, not as an automatic defect or refactoring verdict.
---

# Happier Slopo

Use Slopo to find structurally similar production implementations that deserve
owner-level inspection. The repository configuration is `slopo.conf.yaml`; local
embeddings, database, and reports live under ignored `.slopo/`.

Slopo complements `skills/happier-review`. It does not replace source tracing,
the canonical plans, tests, Graphify or another architecture graph, or loaded
runtime evidence.

## Before a scan

1. Normalize the review target and intent through `skills/happier-review` when a
   review or completeness conclusion is requested.
2. Record the current `HEAD`, acknowledge relevant dirty work, and name the source
   corridor being assessed. Do not freeze, stash, clean, or manufacture a clean
   worktree.
3. Run `slopo --version` and `slopo show-config`. The validated baseline is Slopo
   0.5.0 with the 768-dimensional Ollama model configured in
   `slopo.conf.yaml`. Treat results from another Slopo version, model, model
   digest, dimensions, threshold, or source root as a new baseline.
4. Verify that Ollama is reachable and the configured model is installed. Do not
   install or update tools or models without the authority applicable to that
   task. Never place provider credentials in repository configuration; Slopo can
   read `SLOPO_EMBEDDING_API_KEY` when an authorized external provider is used.

The model name does not prove that its local bytes are unchanged. Do not update
the model while reusing `.slopo/slopo.db`. If its digest or configured parsing
threshold changes, rebuild the reconstructible ignored database before comparing
the new report with prior measurements.

## Run the repository workflow

Create the ignored artifact directory, then run the commands from the repository
root through the local executor because the configured embedding service is local:

```sh
mkdir -p .slopo
./apps/stack/bin/hstack-exec --local -- slopo show-config
./apps/stack/bin/hstack-exec --local -- slopo index
./apps/stack/bin/hstack-exec --local -- slopo embed
./apps/stack/bin/hstack-exec --local -- slopo analyze
```

`index` and `embed` are incremental when the configuration and local database are
unchanged. Do not delete an existing database merely to obtain a clean-looking
run. Rebuild it only when a configuration/model change makes its embeddings
incomparable, and report that reset as discarded local derived data.

For a deliberately narrower scan, create an isolated temporary source projection
and temporary configuration outside the repository. Preserve package identities,
exclude generated/test/fixture content consistently, and state the exact included
corridor. Never present a projection scan as whole-repository coverage.

## Interpret the report

Read `.slopo/report/index.md`, then inspect a bounded top set appropriate to the
request. Classify each credible cluster as one of:

- likely competing owner or split-brain;
- repeated mechanism worth canonical-owner consolidation;
- intentional bounded-context or provider variation;
- generic/helper similarity with no demonstrated maintenance risk;
- generated, vendored, fixture, or other scope noise that should be excluded.

Similarity is a retrieval signal, not a finding. Before reporting or changing
code, trace inputs, callers, state/lifecycle ownership, observable behavior,
tests, compatibility paths, and the relevant current plan. A refactor candidate
must name the duplicate decision or caller knowledge it would remove. Do not
centralize coincidental syntax or erase intentional Agent/Provider leaf behavior.

Add a cluster hash to `slopo.ignore.txt` only after its current units were reviewed
and dismissed as intentional. Keep the reason in the same line or an adjacent
comment. Do not bulk-ignore a directory merely to improve the score.

## Report and rejoin review

Feed accepted candidates into `skills/happier-review` for finding verification,
impact, authority, and any authorized fix. Report:

- Slopo version, model identity/digest when available, thresholds, source root,
  exclusions, and whether the database was incremental or rebuilt;
- indexed/embedded unit counts, exact-copy count, non-exact flagged count, and
  cluster count;
- which clusters were inspected and their evidence-backed disposition;
- unsupported languages, excluded surfaces, moving-worktree changes, failures,
  and other limits on the conclusion.

Do not use total similarity percentage as a CI gate, code-quality score, plan
completion signal, or instruction to refactor. Trend new reviewed clusters only
after a stable baseline exists and the same configuration/model basis is proven.
