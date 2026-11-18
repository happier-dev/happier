import { describe, expect, it } from 'vitest';

import type { BotFaceSnapshot } from '../../presentation/notchBotTypes';
import type { DesktopActivityOverlayAttentionMark } from '../../presentation/model/desktopActivityOverlayModelTypes';
import { APP_RAIL_BADGE, APP_RAIL_BADGE_OVERLAP_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { resolveNotchRestMarkShiftPx, resolveNotchRestMarks } from './notchRestMarks';

const face = (sessionId: string, activity: BotFaceSnapshot['activity']) =>
  ({ serverId: 's', sessionId, activity }) as BotFaceSnapshot;
const session = (sessionId: string): DesktopActivityOverlayAttentionMark => ({
  serverId: 's',
  sessionId,
  agentId: 'codex',
  machineId: null,
  botFace: null,
});
const ids = (result: ReturnType<typeof resolveNotchRestMarks>) =>
  result.shown.map((mark) =>
    mark.kind === 'face' ? mark.face.sessionId : mark.mark.sessionId,
  );

describe('resolveNotchRestMarks', () => {
  it('stacks what needs you first, Bots before Sessions, then the other faces, three at most and the rest as +N', () => {
    const result = resolveNotchRestMarks(
      [face('working-pin', 'working'), face('asking-bot', 'needsYou')],
      [session('asker-1'), session('asker-2')],
    );
    expect(ids(result)).toEqual(['asking-bot', 'asker-1', 'asker-2']);
    expect(result.more).toBe(1);
  });

  it('shows every mark with no +N when three or fewer stand', () => {
    const result = resolveNotchRestMarks(
      [face('asking-bot', 'needsYou')],
      [session('asker-1')],
    );
    expect(ids(result)).toEqual(['asking-bot', 'asker-1']);
    expect(result.more).toBe(0);
  });

  it('is empty when nothing needs you and no face is shown', () => {
    expect(resolveNotchRestMarks([], [])).toEqual({ shown: [], more: 0 });
  });

    it('centres each mark together with the needs-you dot it carries on the column, whatever the mark size', () => {
        const column = 32;
        const dot = APP_RAIL_BADGE.dotSizePx + 2 * APP_RAIL_BADGE.ringPx;
        for (const mark of [14, 20]) {
            const left = (column - mark) / 2 + resolveNotchRestMarkShiftPx();
            const right = Math.max(left + mark, left + mark - APP_RAIL_BADGE_OVERLAP_PX + dot);
            expect((left + right) / 2).toBeCloseTo(column / 2);
        }
    });
});
