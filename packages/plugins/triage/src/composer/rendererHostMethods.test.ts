import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

/**
 * `requiredHostMethods` is a renderer ADMISSION contract, not an availability
 * claim: the host mounts a renderer only when every declared method is in that
 * mount's factually installed set. Both directions are therefore defects.
 *
 * Under-declaring mounts a surface that cannot do its job and fails at the
 * first press. Over-declaring refuses the surface outright — a strictly worse
 * outcome than the degraded one it was trying to prevent.
 *
 * Triage's two Composer-mounted renderers reach the draft through
 * `useComposerView`/`ComposerHandle`, which resolve to exactly three canonical
 * Host API methods (`plugin-ui/src/composer/service.ts`): `read` →
 * `readComposer`, `observe` → `watchComposer`, `apply` → `applyComposer`.
 * `composers.get(ref)` resolves to no host call at all, so binding a handle
 * requires nothing.
 *
 * A Composer scope is not a navigation-free scope: it hands its physical
 * surfaces the same enclosing qualified-destination binding every other
 * mounted surface consumes, so `openSurface` is installed wherever that owner
 * exists and **View details** is admitted with the rest of the picker.
 */

function declaredHostMethods(rendererId: string): readonly string[] | undefined {
    const renderer = (PLUGIN_MANIFEST.contributes.ui?.renderers ?? [])
        .find((candidate) => candidate.id === rendererId);
    if (!renderer) throw new Error(`Expected a declared renderer named ${rendererId}`);
    return renderer.requiredHostMethods;
}

describe('Triage Composer renderer host-method declarations', () => {
    it('declares every Host API method the entry picker unconditionally calls', () => {
        // `useTriageListWindow` → `executeAction` (the picker runs in its own
        // artifact realm, so its window starts cold and **Refresh** is the only
        // way it ever holds rows); `useComposerView` → `readComposer` +
        // `watchComposer` on every mount; `applyTriageEntryMutation` →
        // `readComposer` + `applyComposer` for Attach/Remove, which is the
        // entire reason this surface exists; `openTriageEntryDetails` →
        // `openSurface`, the whole of **View details**.
        expect([...declaredHostMethods('entry-picker') ?? []].sort())
            .toEqual(['applyComposer', 'executeAction', 'openSurface', 'readComposer', 'watchComposer']);
    });

    it('declares the canonical snapshot methods the compact label reads from', () => {
        // The compact label is presentation, but not self-contained: it holds no
        // count of its own and derives zero/one/many from the canonical composer
        // snapshot. It never calls `refresh()`, so `watchComposer` is its only
        // update path after mount — without it the label freezes at its
        // mount-time value and then claims attachments the message will not
        // carry, which is exactly the state this renderer exists to prevent.
        expect([...declaredHostMethods('entries-compact') ?? []].sort())
            .toEqual(['readComposer', 'watchComposer']);
    });

    it('keeps Composer methods off the renderers that never bind a draft', () => {
        // The app page and the Session panel mount outside any Composer scope.
        // A Composer method declared there is unsatisfiable at their mounts and
        // would refuse both surfaces.
        const composerMethods = ['readComposer', 'watchComposer', 'applyComposer'];
        for (const rendererId of [
            'list-page',
            'session-entries-panel',
        ]) {
            const declared = declaredHostMethods(rendererId) ?? [];
            for (const method of composerMethods) expect(declared).not.toContain(method);
        }
    });
});
