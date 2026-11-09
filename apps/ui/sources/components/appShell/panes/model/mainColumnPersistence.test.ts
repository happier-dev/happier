import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from './appPaneReducer';
import { paneScopeStateSchema, EMPTY_PERSISTED_PANE_SCOPE_STATE } from './paneScopePersistenceSchema';

describe('main column persisted preference', () => {
    it('reads omitted hide state as visible and retains canonical new writes', () => {
        const legacy = paneScopeStateSchema.parse({ ...EMPTY_PERSISTED_PANE_SCOPE_STATE, mainHidden: undefined, futureField: 1 });
        expect(legacy.mainHidden).toBe(false);
        let state = createAppPaneState({ maxScopesInMemory: 12 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: 'app' });
        state = appPaneReduce(state, { type: 'setMainHidden', scopeId: 'app', hidden: true });
        const saved = paneScopeStateSchema.parse(state.scopes.app);
        expect(saved.mainHidden).toBe(true);
        expect(saved).not.toHaveProperty('futureField');
    });
});
