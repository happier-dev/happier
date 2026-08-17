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
the action through the public testkit. Run the package-local lifecycle with the
canonical author, pack, and disposable-daemon owners:

```bash
happier plugins author typecheck .
happier plugins author build .
happier plugins test .
happier plugins test . --packed
```

The final command packs, trusts, installs, restarts, and invokes this package's
safe empty-input `summarize` Action. It is package/load evidence only; it does
not claim a mounted host or settled-candidate proof.

The provider's attach URL and Agent runtime are illustrative only; they do not
contact or launch a real service. Copy the ownership pattern, then replace
them with your declared, validated runtime behavior.
