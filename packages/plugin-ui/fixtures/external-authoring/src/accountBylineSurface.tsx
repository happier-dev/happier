import { AccountByline, ApprovalPrompt, Text, useAccountActorName, type AccountActorLabel } from '@happier-dev/plugin-ui/components';

/**
 * The author classifies who took part from its own data; Happier supplies the words for You, a member
 * without a name and a former member, and the byline's anatomy. Who may decide stays with the author.
 */
export function AccountBylineExample(props: Readonly<{ requester?: AccountActorLabel }>) {
  const requester = useAccountActorName(props.requester ?? { kind: 'former' });
  return <>
    <AccountByline testID="author-byline-profile" actor={{ kind: 'profile', label: 'Mara Chen' }} />
    <AccountByline testID="author-byline-self" actor={{ kind: 'self' }} />
    <AccountByline testID="author-byline-unnamed" actor={{ kind: 'unnamed' }} />
    <AccountByline testID="author-byline-former" actor={{ kind: 'former' }} />
    <ApprovalPrompt testID="author-requester-card" title="Open the release pull request"
      footer={<Text testID="author-requester-waiting" tone="secondary" value={`Waiting for ${requester} to confirm`} />} />
  </>;
}
