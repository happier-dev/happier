import * as React from 'react';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** The reveal modal outlives its creation route, so it owns this copy's approval lifetime. */
export function EmbedRevealEnvironmentCopy(props: Readonly<{
    token: string;
    scope: ServerAccountScope | null;
    onCopied: () => void;
}>) {
    const writeClipboard = useClipboardWrite(props.scope);
    return (
        <RoundButton
            testID="settings-embed-reveal-env"
            size="normal"
            display="secondary"
            title={t('settingsEmbeds.reveal.copyEnv')}
            onPress={async () => {
                if (await writeClipboard(`HAPPIER_EMBED_KEY=${props.token}`)) props.onCopied();
            }}
        />
    );
}
