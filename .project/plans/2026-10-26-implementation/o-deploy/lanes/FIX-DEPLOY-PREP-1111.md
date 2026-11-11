VERDICT: IMPLEMENTED_NOT_VERIFIED — A1 and corrected relay consolidation landed; A2 table deletion remains open for owner review

## Outcome

Fixed the Home-signed `deployment_preparation` refusal for catalog preparation that creates a new Project. The canonical owner now consumes the admitted Project request key to resolve the created Environment and its Project Source before authorizing the Source read. Also removed the retained Bot-template and deployment-native relay shortcuts (including route and dispatcher consumers), deleted the per-call Machine admission re-run, and kept the Lane 12 dependency-free binding-authority leaf and consumers.

## Evidence

- RED: the real `projectSourceRoutes` request for a newly created Project returned HTTP 401 with `authorizationRefusal: deployment_preparation`.
- GREEN: the same owner-level request returns HTTP 200 after the fix; changing the Source owner to a second Account returns HTTP 401.
- Focused test: `deploymentCreatePreparation.sqlite.integration.spec.ts` targeted regression passed (1 passed, 27 skipped).
- Lane 12 replay RED: `externalActionRootReplayAfterRevocation.sqlite.integration.spec.ts` passed (1 test); the revoked member's person-presented root was refused on replay.
- Entry loads: `pnpm check:entry-loads` passed all 13 graphs, including server, CLI, daemon, UI catalog, protocol and SDK browser.
- Protocol import cycles: passed.
- Broader composed deployment run: the create-preparation file passed; the concurrent child-authorization file reported 15 failures in pre-existing/shared moving work, so it is not claimed green for this lane.
- Typecheck was not run; the common brief assigns it to the package wave.

## Admission change

`readDeploymentPreparationSourceHttpPurposeInTx` retains the existing exact Source revision and account-owner checks for an admitted Source. For a catalog admission with `newProject`, it resolves the acknowledged created Environment by `newProject.requestKey`, reads that Environment's Project Source custody, and spends that admitted relation. Missing allocation, foreign ownership, mismatched Home/Machine/installation, and unrelated Source paths still refuse. A1 now checks only the current Machine row, installation/custodian identity, handoff tuple and run/source liveness. Person-presented relays use the ordinary current-principal path; daemon-signed relays are unchanged.

## Commit

Consolidation commits: `4c6138dc498c55c4974b1fe512414df172be5636` (source and Lane 12 leaf/consumer hunks), `d0134203f8823b40671da0cd28772d3b0c5232d3` (report/board), and `fd663f372e5e61a044fcfc49349bbdc8b7b72c37` (replay regression). The earlier source-read fix remains `6c923abd36e279dfa019784ae15079a67915fecb`.

## Residual risk

The composed child-authorization suite remains red in the shared checkout with failures outside the changed owner path; those failures need the integration owner to re-attribute against its moving baseline. The requested A2 deletion of the remaining deployment per-purpose tables was not completed in this handoff and requires the owner-level follow-up before a final READY verdict. No migrations, wire schema changes, timers, retries, expiry or single-use records were added.
