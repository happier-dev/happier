import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const bottomFollowHostPath = path.resolve(
    __dirname,
    'viewport/bottomFollow/host/useTranscriptBottomFollowHost.ts',
);
const chatListInternalPath = path.resolve(__dirname, 'ChatListInternal.tsx');

describe('ChatList renderer-owned bottom follow boundary', () => {
    it('retains only explicit and exceptional blank-recovery app writes', () => {
        const source = fs.readFileSync(bottomFollowHostPath, 'utf8');

        expect(source).toContain('planBottomFollowWriteSchedulerEvent');
        expect(source).toContain("writer: BottomFollowAutomaticWriter");
        expect(source).not.toMatch(
            /requestAutomaticLiveTailPin|requestBottomFollowScheduledWrite|proactive-auto-follow|settle-reconfirm|deferred-post-scroll/,
        );
    });

    it('has no app-owned continuous-follow or ignored Flash override wiring', () => {
        const source = fs.readFileSync(chatListInternalPath, 'utf8');

        expect(source).not.toContain('continuousFollowOwner');
        expect(source).not.toContain('nativeListInteractionOverrideProps');
        expect(source).not.toContain('overrideProps=');
    });

    it('delegates renderer-owned viewport resize maintenance through the renderer ref', () => {
        const source = fs.readFileSync(chatListInternalPath, 'utf8');
        const body = extractCallbackBody(source, 'handleComposerInsetHeightChange');

        expect(body).toContain('listRef.current?.notifyViewportGeometryChanged?.()');
        expect(body).not.toContain('requestAutomaticLiveTailPin(');
    });
});

function extractCallbackBody(source: string, callbackName: string): string {
    const start = source.indexOf(`const ${callbackName} = React.useCallback`);
    expect(start, `missing callback ${callbackName}`).toBeGreaterThanOrEqual(0);
    const nextConst = source.indexOf('\n    const ', start + 1);
    const nextReact = source.indexOf('\n    React.', start + 1);
    const candidates = [nextConst, nextReact].filter((index) => index >= 0);
    const end = candidates.length > 0 ? Math.min(...candidates) : undefined;
    return source.slice(start, end);
}
