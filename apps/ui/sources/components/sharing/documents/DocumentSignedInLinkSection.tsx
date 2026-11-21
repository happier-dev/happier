import * as React from 'react';
import { View } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

export function DocumentSignedInLinkSection(props: Readonly<{
    value: boolean; onChange(value: boolean): void | Promise<void>; disabled?: boolean; shareUrl: string | null;
    scope: ServerAccountScope; idPrefix: string; onReplace?: () => Promise<void>;
    audience?: 'anonymous' | 'signed_in';
    presentFailure?: (error: unknown) => Readonly<{ message: string }>;
}>) {
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<Readonly<{ error: unknown }> | null>(null);
    const [copied, setCopied] = React.useState(false);
    const copy = useClipboardWrite(props.scope);
    const signedIn = props.audience !== 'anonymous';
    const perform = async (operation: () => void | Promise<void>, requiresEdit = true) => {
        if ((requiresEdit && props.disabled) || pending) return;
        setPending(true); setFailure(null); setCopied(false);
        try { await operation(); } catch (error) { setFailure({ error }); }
        finally { setPending(false); }
    };
    return <View>
        <Item title={t(signedIn ? 'botTemplates.signedInLink' : 'session.sharing.publicLink')}
            subtitle={t(signedIn ? 'botTemplates.signedInLinkDescription' : 'shareSheet.publicLink.description')}
            rightElement={signedIn ? <Switch testID={`${props.idPrefix}document-share-signed-in-link`} value={props.value}
                disabled={props.disabled || pending} onValueChange={value => { void perform(() => props.onChange(value)); }} /> : undefined} />
        {signedIn ? <Text variant="meta">{t('botTemplates.signedInLinkKeepsAccess')}</Text> : null}
        {props.shareUrl ? <>
            <Text selectable variant="body">{props.shareUrl}</Text>
            <RoundButton size="small" display="secondary" title={t(copied ? 'shareSheet.linkCopied' : 'shareSheet.copyLink')}
                testID={`${props.idPrefix}document-share-signed-in-link-copy`} onPress={() => {
                    void perform(async () => {
                        if (!await copy(props.shareUrl!)) throw new Error('clipboard_unavailable');
                        setCopied(true);
                    }, false);
                }} loading={pending} />
        </> : props.value && props.onReplace ? <RoundButton size="small" display="secondary"
            title={t('session.sharing.regeneratePublicLink')} loading={pending} disabled={props.disabled || pending}
            onPress={() => { void perform(props.onReplace!); }} /> : null}
        {failure ? <Text variant="meta" accessibilityLiveRegion="polite">{props.presentFailure?.(failure.error).message ?? t('botTemplates.unavailable')}</Text> : null}
    </View>;
}
