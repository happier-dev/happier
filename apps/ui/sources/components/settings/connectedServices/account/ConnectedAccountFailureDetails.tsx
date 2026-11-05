import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DisclosedCodeText, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

const stylesheet = StyleSheet.create(theme => ({
    root: { gap: theme.space.s4, alignItems: 'flex-start' },
    details: { gap: theme.space.s4, alignItems: 'flex-start', alignSelf: 'stretch' },
}));

/** Only the typed failure and opaque correlation identity; never provider prose or operands. */
export function ConnectedAccountFailureDetails(props: Readonly<{
    code: string;
    correlationId?: string | null;
    scope: ServerAccountScope | null;
}>) {
    const [open, setOpen] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const binding = useCoreDisclosureToggleBinding();
    const writeClipboard = useClipboardWrite(props.scope, { enabled: open });
    const details = props.correlationId ? `${props.code}\n${props.correlationId}` : props.code;
    return (
        <View style={stylesheet.root}>
            <HappierDisclosureToggle
                testID="connected-account:error-details-toggle"
                label={t('common.details')}
                open={open}
                onPress={() => { setOpen(value => !value); setCopied(false); }}
                caret={binding.renderCaret(open)}
                renderLabel={binding.renderLabel}
                focusColor={binding.focusColor}
            />
            {open ? (
                <View style={stylesheet.details}>
                    <DisclosedCodeText testID="connected-account:error-details-code">{details}</DisclosedCodeText>
                    <RoundButton
                        testID="connected-account:error-details-copy"
                        size="small"
                        display="inverted"
                        title={copied ? t('common.copied') : t('common.copy')}
                        onPress={() => { void writeClipboard(details).then(setCopied); }}
                    />
                </View>
            ) : null}
        </View>
    );
}
