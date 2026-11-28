import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Opens New bot (lab session-orchestration N1): a large card, edge to edge, no title band (its title stays the
 * accessible name); a phone gets it as a full-screen page. The body loads only when opened.
 */
export function openNewBotChooser(
  Bridge: React.ComponentType<Readonly<{ children: React.ReactNode }>>,
): void {
  fireAndForget(
    import('./NewBotChooser').then(({ NewBotChooser }) => {
      Modal.show({
        component: (props) => (
          <Bridge>
            <NewBotChooser {...props} />
          </Bridge>
        ),
        chrome: {
          kind: 'card',
          header: 'none',
          title: t('bots.new'),
          material: 'solid',
          phonePresentation: 'fullscreen',
          scrollHost: 'body',
          bodyScroll: 'none',
          testID: 'new-bot-chooser',
          dimensions: { size: 'lg', maxHeightRatio: 0.82 },
        },
        closeOnBackdrop: true,
      });
    }),
    { tag: 'NewBot.chooser' },
  );
}
