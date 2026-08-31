# Bug-fix loop

Read this reference for a reported regression, incorrect behavior, crash, data error, race, security defect, lifecycle failure, or review finding whose root cause is not already established.

## 1. Establish the contract and reproduce

- Separate the user's observed symptom from their proposed diagnosis or fix.
- Derive expected behavior from the explicit request, approved plan when applicable, current public/external contract, or established canonical behavior.
- Reproduce the failure at the smallest real boundary that preserves it. When direct reproduction is infeasible, identify the factual failing path from logs, state, source, and existing evidence.
- Record the exact inputs, state, environment/runtime identity, expected result, actual result, and failure window.

Do not confidently pass or fail a behavior whose expected result is materially unspecified. Name the decision or evidence needed.

## 2. Find the originating failure layer

Classify where the defect entered:

- intent or approved contract;
- plan design, ownership, or integration mapping;
- canonical production implementation;
- test, fixture, mock, or harness;
- runtime environment, deployed artifact, or external contract;
- unrelated system.

Repair the originating layer. A plan-level correction that changes approved outcomes remains `AMENDMENT_REQUIRED` under `.agents/skills/happier-implement-plan`; a harness defect is not evidence that production is wrong; an environment failure is not fixed by weakening product behavior.

## 3. Discriminate causes with evidence

Trace inputs through normalization, decisions, state/persistence, side effects, readers, and outputs. Correlate timestamps and identities across relevant logs or artifacts.

When the evidence supports materially different explanations, name the plausible alternatives and obtain the cheapest observation that distinguishes them. Do not manufacture a second hypothesis when the failure is directly established, and do not keep accumulating alternatives after the cause is decided.

A root-cause claim requires evidence that demonstrates both reachability and the failure mechanism. A nearby error, suspicious code, or repeated reviewer opinion is not enough.

## 4. Find the canonical choke point and blast radius

Name:

- the authoritative owner of the failed invariant;
- every materially affected caller, reader, writer, consumer, and platform path;
- duplicate decisions, bypasses, legacy implementations, and compatibility adapters;
- the neighboring cases most likely to share the same cause.

The correct fix may be broad when one owner must govern several paths. Do not patch only the reproduced caller while leaving the same reachable defect or competing decision elsewhere. Do not absorb unrelated debt or centralize coincidental similarity.

## 5. Prove regression RED

Use or strengthen the closest owner-level test that distinguishes the intended behavior from the observed defect or another plausible wrong implementation.

- Confirm RED fails for the intended reason.
- Keep internal behavior real and mock only the genuine external boundary.
- If the defect exists only in a real browser/device/process/provider environment, preserve that live reproduction as the deciding gate and add the strongest useful automated contract below it.

## 6. Implement the smallest coherent root-cause fix

Correct the failed invariant at its owner. Reuse or refine existing mechanisms before adding another. Migrate/remove affected bypasses or duplicate owners when the correction makes them obsolete.

Treat mitigations separately:

- A mitigation is justified only when it is the safest authorized immediate response.
- Keep it narrow, labeled, and tested.
- Do not report mitigation as root-cause completion.
- Name the remaining owner-level correction and authority needed.

## 7. Verify through a different path

- Prove GREEN at the regression boundary.
- Replay the original reproduction against the relevant current build/runtime.
- Check materially neighboring inputs, repeat/resume/recovery behavior, and affected platform or compatibility directions.
- Inspect consumers and state after the operation, not only the immediate return value.
- Recheck the changed corridor for a new fallback, bypass, split-brain, or stale test contract.

If implementation is present but the real failure surface did not run, report `IMPLEMENTED_NOT_VERIFIED`.

## 8. Report cause and response separately

Report:

- observed symptom;
- verified root cause and originating layer;
- canonical owner and affected corridor;
- implemented correction;
- regression RED/GREEN and live replay evidence;
- skipped or unavailable checks;
- residual risk.

A verified cause does not automatically verify the proposed response. Label response confidence separately when it was not implemented or exercised.
