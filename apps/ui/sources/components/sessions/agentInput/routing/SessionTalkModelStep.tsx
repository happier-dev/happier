import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionServerStartDraftComposerBody } from '@/components/sessions/new/SessionServerStartDraftComposerBody';
import { useSessionServerStartDraftRecipe } from '@/components/sessions/new/useSessionServerStartDraftRecipe';
import type { SessionServerStartDraftSeed, SessionServerStartDraftTarget } from '@/components/sessions/new/serverStartDraftComposer';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SessionTalkStepBack } from './SessionTalkStepBack';

/** A value-only New Session recipe inside To. Only the composer's Send starts it. */
export function SessionTalkModelStep(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    frameHeight?: number;
    onBack: () => void;
    onUse: (launch: SessionServerStartSpawnDraftV1) => void;
}>) {
    const model = useSessionServerStartDraftRecipe(props);
    return <View testID="session-talk-model" style={[styles.root, props.frameHeight ? { height: props.frameHeight } : undefined]}>
        <SessionTalkStepBack testID="session-talk-model-back" onBack={props.onBack} />
        <View style={styles.body}>
            <SessionServerStartDraftComposerBody seed={props.seed} model={model} />
        </View>
        <View style={styles.footer}>
            <Text style={styles.fact}>{t('session.participants.talk.modelStarts', {
                machine: model.machine ? getMachineDisplayName(model.machine) : t('common.unavailable'),
            })}</Text>
            <RoundButton testID="session-talk-model-use" size="small" title={t('session.participants.talk.modelUse')}
                disabled={!model.canSubmit} onPress={() => {
                    const launch = model.resolveDraft();
                    if (launch) props.onUse(launch);
                }} />
        </View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    root: { minHeight: 0 },
    body: { flex: 1, minHeight: 0 },
    footer: { gap: theme.space.s8, padding: theme.space.s12 },
    fact: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
