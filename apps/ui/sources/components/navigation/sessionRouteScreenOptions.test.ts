import { describe, expect, it } from 'vitest';

import { buildSessionRouteScreenOptions } from './sessionRouteScreenOptions';
import { t } from '@/text';

/**
 * `session/[id]` is one screen of the root stack (its `_layout` is a Slot), so every Session
 * sub-route shares that screen's options. The Session view and its cockpit surfaces draw their own
 * header — with the back affordance inline on phones — so the stack must not add a second header
 * row (the big back arrow above the Session header).
 */
describe('Session route screen options', () => {
    it.each([
        ['the Session view', 'index'],
        ['the initial render, before the nested route resolves', undefined],
        ['the files surface', 'files'],
        ['the git surface', 'git'],
        ['the details surface', 'details'],
        ['the terminal surface', 'terminal'],
    ] as const)('draws no stack header over %s', (_name, childRouteName) => {
        expect(buildSessionRouteScreenOptions({ childRouteName })).toMatchObject({ headerShown: false });
    });

    it('keeps the iOS back swipe on the leading edge, so a sideways stroke on the Session bar switches Sessions', () => {
        // iOS 26 turns an unset full-screen swipe into a back gesture from anywhere, which took every
        // rightward stroke on the bar (device-reproduced 2026-11-10); the bar reserves only the edge.
        expect(buildSessionRouteScreenOptions({ childRouteName: 'index' })).toMatchObject({ fullScreenGestureEnabled: false });
    });

    it('leaves a Session sub-page that declares its own stack header alone', () => {
        expect(buildSessionRouteScreenOptions({ childRouteName: 'follow' })).toEqual({});
    });

    it('titles the Session Info bar "Session Info" (owner 2026-11-17) and never the route pattern', () => {
        const options = buildSessionRouteScreenOptions({ childRouteName: 'info' });
        expect(options).toMatchObject({ headerShown: true, headerTitle: t('sessionInfo.title') });
    });

    it.each([
        ['log', 'sessionLog.title'], ['usage', 'usage.sessionUsage'], ['template', 'botTemplates.title'],
        ['file', 'common.fileViewer'], ['commit', 'common.commit'], ['message/[messageId]', 'common.message'],
        ['sharing', 'session.collaboration.title'], ['triggers', 'sessionInfo.title'], ['automations', 'sessionInfo.title'],
        ['runs', 'session.subagents.panel.title'],
        ['automations/new', 'sessionInfo.title'], ['automations/when-turn-finishes', 'sessionInfo.title'],
    ] as const)('names %s before its body or compatibility redirect resolves', (childRouteName, key) => {
        expect(buildSessionRouteScreenOptions({ childRouteName })).toMatchObject({ headerShown: true, headerTitle: t(key) });
    });
});
