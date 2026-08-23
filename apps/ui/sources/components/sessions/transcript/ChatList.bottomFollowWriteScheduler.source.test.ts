import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const bottomFollowHostPath = path.resolve(
    __dirname,
    'viewport/bottomFollow/host/useTranscriptBottomFollowHost.ts',
);
const chatListInternalPath = path.resolve(__dirname, 'ChatListInternal.tsx');

describe('ChatList bottom-follow write scheduler boundary', () => {
    it('routes automatic bottom-follow write authorities through the scheduler owner', () => {
        const source = fs.readFileSync(bottomFollowHostPath, 'utf8');

        expect(source).toContain('planBottomFollowWriteSchedulerEvent');

        for (const callbackName of [
            'applyWebPassiveLiveTailCorrectionEffect',
            'applyNativeEntrySettleConfirmationEffects',
            'pinNativeLiveTailForHotTailHeight',
            'deferPinToBottomAfterScroll',
            'requestMeasuredNativeAutomaticLiveTailPin',
        ]) {
            const body = extractCallbackBody(source, callbackName);
            expect(body).toContain('authorizeImmediateBottomFollowWriteRef.current');
            expect(body).not.toMatch(/(pinNativeFlashListToBottomIfMeasured|pinToBottomRespectingNativeMountSettle|pinToBottom|applyWebBottomFollowAdjustment)\(/);
        }

        expect(source).not.toContain('applyContentGrowthLiveTailScheduledPinFireEffects');
    });

    it('keeps proactive stream-append auto-follow behind the app-owned continuous-follow branch', () => {
        const source = fs.readFileSync(bottomFollowHostPath, 'utf8');
        const body = extractLayoutEffectBody(source, 'lastProactiveAutoFollowActivityKeyRef');

        const rendererGateIndex = body.indexOf("continuousFollowOwner === 'renderer'");
        const writeIndex = body.indexOf("authorizeImmediateBottomFollowWriteRef.current('proactive-auto-follow', 'stream-append')");

        expect(writeIndex).toBeGreaterThanOrEqual(0);
        expect(rendererGateIndex).toBeGreaterThanOrEqual(0);
        expect(rendererGateIndex).toBeLessThan(writeIndex);
    });

    it('delegates renderer-owned viewport resize maintenance through the renderer ref', () => {
        const source = fs.readFileSync(chatListInternalPath, 'utf8');
        const body = extractCallbackBody(source, 'handleComposerInsetHeightChange');

        expect(body).toContain("mainTranscriptRendererOwnerPolicy.continuousFollow === 'app'");
        expect(body).toContain("requestAutomaticLiveTailPin(null, 'viewport-resized')");
        expect(body).toContain('listRef.current?.notifyViewportGeometryChanged?.()');
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

function extractLayoutEffectBody(source: string, anchor: string): string {
    const anchorIndex = source.indexOf(anchor);
    expect(anchorIndex, `missing layout effect anchor ${anchor}`).toBeGreaterThanOrEqual(0);
    const start = source.lastIndexOf('React.useLayoutEffect(() => {', anchorIndex);
    expect(start, `missing layout effect for ${anchor}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n    }, [', anchorIndex);
    expect(end, `missing layout effect dependencies for ${anchor}`).toBeGreaterThanOrEqual(0);
    return source.slice(start, end);
}
