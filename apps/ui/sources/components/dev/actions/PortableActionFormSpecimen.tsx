import * as React from 'react';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';

import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * A released portable Account Action as its author declares it: a required note and an optional switch,
 * with NO authored input hints. The form's fields come from the same Protocol completion the Account reader
 * and the daemon project (`normalizePluginActionInputHintsV2`; with no authored hints the overlay adds nothing), drawn by the one
 * shared form owner. `?variant=note` (default; Post succeeds and the form closes) or `failed` (Post settles
 * with the typed refusal an Account activation failure returns). Composition only: nothing is sent anywhere.
 */
const DECLARATION = {
  title: 'Post a standup note',
  description: 'Shares a short note in your team’s standup channel.',
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        minLength: 1,
        title: 'Note',
        description: 'One or two lines. Your team sees it as written.',
      },
      mentionTeam: {
        type: 'boolean',
        title: 'Mention the team',
        description: 'Notifies everyone in the channel.',
      },
    },
    required: ['note'],
    additionalProperties: false,
  },
} as const;

const FAILED_OUTCOME = {
  ok: false,
  code: 'activation_failed',
  phase: 'plugin.account.activate',
  requestId: '5f1c2a9e-77b0-4d2e-9a61-0c3e8f4b2d17',
  effectAttempted: false,
} as const;

function openForm(variant: string): void {
  const completed = normalizePluginActionInputHintsV2(
    undefined,
    DECLARATION.inputSchema,
  );
  if (!completed) return;
  const form = createActionInputForm({
    presentation: {
      title: DECLARATION.title,
      description: DECLARATION.description,
      inputHints: completed,
    },
    submit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return variant === 'failed' ? FAILED_OUTCOME : { ok: true };
    },
  });
  presentActionInputForm({ form, actionId: 'qa.standup/post-note' });
}

export function PortableActionFormSpecimen(
  props: Readonly<{ variant: string }>,
): React.ReactElement {
  React.useEffect(() => {
    openForm(props.variant);
  }, [props.variant]);
  return (
    <ItemList>
      <ItemGroup
        title="Portable Action form"
        description="A released Account Action with a required note and no authored hints."
      >
        <Item
          title={DECLARATION.title}
          subtitle={DECLARATION.description}
          rightElement={
            <RoundButton
              size="small"
              display="secondary"
              title="Open"
              onPress={() => openForm(props.variant)}
            />
          }
        />
      </ItemGroup>
    </ItemList>
  );
}
