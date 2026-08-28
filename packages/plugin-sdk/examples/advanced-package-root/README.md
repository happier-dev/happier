# Advanced `definePlugin` package-root reference

This maintained compile reference is for an author who needs a custom
Session Agent, an External Sessions companion, a managed Provider, a
Connected Account purpose, and daemon-generation background work in one
package. It is deliberately not the starting scaffold.

`index.ts` is the daemon activation entry: `definePlugin(...)` produces its
named `manifest` and `activate` exports. It also declares the immutable
`resources/review-guide.md` packaged Resource, which the canonical pack owner
selects with the generated daemon runtime. `agent/reviewAgent.ts` is a distinct,
import-safe Session-runner leaf. Its locator names the same exported factory
registered from activation, and its External Sessions companion is exported
from that same leaf. Activation and runner execution may occur in different
realms, so neither module may depend on a process-global singleton.

The example is compiled outside the workspace through only public SDK exports
by `src/examples/publicAuthoringExamples.test.ts`. That owner also verifies
the action through the public testkit. Run the package-local lifecycle with the canonical managed source-author owner:

```bash
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
happier plugins dev
```

Use the existing development stack to exercise activation, restart, invocation,
and mounted-host behavior. Do not create a separate release archive for this
feature QA.

The provider's attach URL and Agent runtime are illustrative only; they do not
contact or launch a real service. Copy the ownership pattern, then replace
them with your declared, validated runtime behavior.

This compact example intentionally consumes another plugin's Connected Account
service and does not demonstrate a credential producer, Provider-bound Agent,
or request-auth child. The maintained packed external vertical in the Happier
test workspace covers that full lifecycle: novel producer registration,
manual connection, purpose materialization and revocation, Provider contribution
and Agent binding, the public request-auth client source, pack/reviewed install,
immutable-generation update, hard revocation, and uninstall. These are the same
public contracts; bundled plugins receive no additional authoring capability.
