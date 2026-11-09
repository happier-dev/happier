import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierAccountByline,
  type HappierAccountBylineTextProps,
} from '@happier-dev/plugin-ui/presentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { resolveVisibleAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';

export type SessionMessageAccountBylineProps = Readonly<{
  messageId: string;
  actor: TranscriptAccountActor | null | undefined;
  viewerScope: ServerAccountScope | null;
  hasOtherNamedCollaborator: boolean;
}>;

/** Core binds its visibility rule, localized name, text and avatar owner to the public byline presenter. */
export function SessionMessageAccountByline(
  props: SessionMessageAccountBylineProps,
) {
  const { theme } = useUnistyles();
  const presentation = resolveVisibleAccountActorPresentation(props);
  if (!presentation) return null;
  const { name, avatar } = presentation;
  return (
    <HappierAccountByline
      nameTestID={`transcript-account-attribution:${props.messageId}`}
      faceTestID={`transcript-account-avatar:${props.messageId}`}
      name={name}
      accessibilityLabel={t('message.accountActorSentBy', { name })}
      face={
        <Avatar
          id={avatar.id}
          imageUrl={avatar.imageUrl}
          monochrome
          size={20}
        />
      }
      Text={BylineText}
      color={theme.colors.text.secondary}
      space={theme.space}
      style={styles.byline}
    />
  );
}

function BylineText(props: HappierAccountBylineTextProps) {
  return (
    <Text
      testID={props.testID}
      accessibilityRole="text"
      accessibilityLabel={props.accessibilityLabel}
      numberOfLines={props.numberOfLines}
      ellipsizeMode="tail"
      variant="meta"
      style={[props.style as StyleProp<TextStyle>, { color: props.color }]}
    >
      {props.children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  byline: {
    alignSelf: 'flex-end',
    paddingHorizontal: theme.space.s16,
    marginBottom: theme.space.s4,
  },
}));
