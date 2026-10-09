import * as React from 'react';

import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { t } from '@/text';

import { AskHappierMark } from './AskHappierOfferCard';
import {
  ASK_HAPPIER_SETUP_STEP_ID,
  useAskHappierOfferChoices,
  useAskHappierOfferVisible,
} from './useAskHappierOffer';

/**
 * Ask Happier in Home's Get set up (lab `b-rail G`, D33): the same offer as the empty Bots roster,
 * drawn as a set-up block. Start opens the editable guide draft; Not now hides it for this run;
 * the ✕ is Don't show again, the Account-wide setup dismissal. Null once dismissed.
 */
export function useAskHappierSetupItem(
  input: Readonly<{ layout: 'card' | 'row' }>,
): SetupBlockItem | null {
  const visible = useAskHappierOfferVisible();
  const choices = useAskHappierOfferChoices();
  const { layout } = input;
  return React.useMemo(
    (): SetupBlockItem | null =>
      visible
        ? {
            id: ASK_HAPPIER_SETUP_STEP_ID,
            renderTile: () => (
              <SetupBlockTile
                testID="hub-setup.askHappier"
                layout={layout}
                glyph={<AskHappierMark size={22} />}
                title={t('bots.guide.offer')}
                subtitle={t('bots.guide.line')}
                action={{
                  label: t('bots.guide.start'),
                  testID: 'hub-setup.askHappier.start',
                  onPress: choices.start,
                }}
                alternative={{
                  label: t('bots.guide.notNow'),
                  testID: 'hub-setup.askHappier.notNow',
                  onPress: choices.notNow,
                }}
                dismiss={{
                  label: t('bots.guide.dontShowAgain'),
                  tooltip: t('homeSetup.dismissTooltip'),
                  onPress: choices.dontShowAgain,
                }}
              />
            ),
          }
        : null,
    [choices, layout, visible],
  );
}
