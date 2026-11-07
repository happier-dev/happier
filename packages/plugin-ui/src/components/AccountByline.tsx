import type { ReactElement } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierAccountByline,
  type HappierAccountActorLabel,
  type HappierAccountBylineTextProps,
} from '../presentation/account/AccountByline.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Avatar } from './Avatar.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type AccountActorLabel = HappierAccountActorLabel;

export type AccountBylineProps = Readonly<{
  /** Who sent it, as the author's data classified it; Happier supplies the words for You and members. */
  actor: AccountActorLabel;
  testID?: string;
}>;

const ACTOR_COPY = {
  self: ['happier.plugin-ui.accountActor.you', 'You'],
  former: ['happier.plugin-ui.accountActor.former', 'Former member'],
  unnamed: ['happier.plugin-ui.accountActor.unnamed', 'Happier member'],
} as const satisfies Record<
  Exclude<AccountActorLabel['kind'], 'profile'>,
  readonly [string, string]
>;
const SENT_BY: readonly [string, string] = [
  'happier.plugin-ui.accountActor.sentBy',
  'Sent by {name}',
];

/**
 * The name Happier gives a classified Account in the app's language: a profile keeps its own name;
 * You, a member without a name and a former member read as they do everywhere in Happier. Use it in
 * the author's own sentences ("Waiting for {name} to confirm").
 */
export function useAccountActorName(actor: AccountActorLabel): string {
  const translate = usePluginTranslation();
  if (actor.kind === 'profile') return actor.label;
  const [key, fallback] = ACTOR_COPY[actor.kind];
  return translate(key, fallback);
}

/** Who sent a message, as Happier's transcript shows it: the name, then the person's mark. */
export function AccountByline(props: AccountBylineProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const name = useAccountActorName(props.actor);
  return (
    <HappierAccountByline
      testID={props.testID}
      nameTestID={props.testID ? `${props.testID}.name` : undefined}
      faceTestID={props.testID ? `${props.testID}.face` : undefined}
      name={name}
      accessibilityLabel={translate(SENT_BY[0], SENT_BY[1]).replace(
        '{name}',
        name,
      )}
      face={<Avatar name={name} size="medium" />}
      Text={BylineText}
      color={theme.colors.secondaryText}
    />
  );
}

function BylineText(props: HappierAccountBylineTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return (
    <HappierText
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      numberOfLines={props.numberOfLines}
      ellipsizeMode="tail"
      style={[
        resolveHappierTypeRoleStyle('meta', theme, typography),
        { color: props.color },
        props.style,
      ]}
    >
      {props.children}
    </HappierText>
  );
}
