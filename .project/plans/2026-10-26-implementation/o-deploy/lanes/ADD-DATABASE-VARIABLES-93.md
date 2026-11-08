DONE

PostgreSQL preview now accepts its defaults and declared generated password. READY FOR RELOAD. Focused tests pass and entry-loads pass 7/7. The broader Store confirmation test has an unattributed approval refusal (also fails in isolation); touched typecheck is queued and not run.

| Check | Verdict | Evidence |
|---|---|---|
| Loaded diagnosis | REPRODUCED | `.project/tmp/ADD-DATABASE-VARIABLES-93/before-operands.json`: browser receives DB_USER/DB_NAME defaults and DB_PASSWORD generator, but Add supplies `bindings: []`; preview returns `template_variable_required`. |
| Canonical ownership | FIXED | `deploymentPublishActions.ts:14` now builds declared generation selections for Add and Store. Defaults/required-value validation remain in `packages/deployments/src/templates/prepareDeploymentTemplateInstantiationV1.ts:148`; credential generation remains in the daemon template owner. |
| RED | EXPECTED FAIL | `red.log`: bundled PostgreSQL fails with `template_variable_required`; removing DB_USER's default also refuses. The real planner runs behind the daemon HTTP boundary. |
| Focused GREEN | PASS 16/16 | `green.log`: full `useStoreAppListing.test.ts`, including bundled PostgreSQL and truly missing-value controls. |
| Private generated audience | PASS 2/2 | `green-private-audience.log`; generated Saved Secrets have zero additional Account, Team or group grants. |
| Loaded PostgreSQL | PASS | `after-ready.snapshot`, `after-ready.json`, `postgresql-ready.png`: one generator selected, Enough room, Add enabled, no required-variable refusal or entered values. |
| Loaded neighbouring MySQL | PASS | `mysql-ready.snapshot/json`: MYSQL_APP_PASSWORD and MYSQL_ROOT_PASSWORD selected, Enough room and Add enabled. |
| Adjacent tests | 28/29 PASS; one failure | `adjacent.log`: Database page 8/8 and catalog preparation pass. Store self-confirmation fails `action_interactive_review_required`; its fixture has no generators and the same empty bindings as before. The isolated test fails identically in `adjacent-confirmation-isolated.log`; no whole-suite GREEN claim. |
| Entry-loads | PASS 7/7 | `entry-loads.log`, execution handle 90719 exited 0: daemon preparation, daemon, CLI, voice worker, server, UI catalog and SDK browser. |
| Touched typecheck | NOT RUN | `typecheck.log`, handle 41571: canonical `pnpm run tsc --project apps/ui/tsconfig.json --noEmit --pretty false` through hstack-exec queued on linux1 for memory. Coordination 2026-11-08 19:01 permits focused tests + entry-loads when compilation cannot finish. |

All short evidence names above are under `.project/tmp/ADD-DATABASE-VARIABLES-93/`.

Observed path: `DeploymentAddReview` previews `deployments.templates.instantiate`; the sheet renders that Action's refusal rather than validating variables locally. The planner applies the two defaults, then refuses DB_PASSWORD because the UI never selected its declared generator. Manually editing Environment variables cannot repair that absent template selection. Store creation had the same empty-input producer.

The shared builder selects declared generators and explicitly retains a private Saved Secret audience. Add previews and applies the same operand, and its review reuses Store's existing generated-secret explanation. There is no UI copy of required-value validation and no automatic generation during preview.

Same-shape sweep: Store install creation and embedded Add now consume the same builder for every app catalog source, including Service templates and Data services. Defaults already resolve at the planner. Store's partial-install resume deliberately keeps empty selections: the existing planner inherits acknowledged saved bindings rather than regenerating credentials. Generic empty-variable Store cases remain covered by the existing suites.

Self-review: rejected changing the daemon planner to generate implicitly, which would bypass the existing explicit generator/audience input contract. The truly missing default control still fails; PostgreSQL and two-generator MySQL previews succeed. No wire, persistence, schema or runtime authority change. Existing `docs/deployment.md:1067` already documents explicit declared-generator selections, so no documentation contract changes are needed.

Net mechanism delta: policy checks, states, error codes, timers, retries and caches +0/−0; one shared operand builder replaces two empty-binding producers. Production files +0/−0 (3 modified), test files +0/−0 (1 extended), report +1. One existing generated-secret information row is reused in Add so the generation choice is visible.

Residual risk: live apply, Saved Secret creation, deployment and the restore chain were intentionally not executed under the read-only stack grant; O-DEPLOY owns that replay after reload. The separate Store confirmation refusal remains unattributed. Full compiler evidence is unavailable while its admitted command is queued.
