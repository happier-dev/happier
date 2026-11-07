import * as React from 'react';
import { View } from 'react-native';

import { BotFace } from '@/components/sessions/bots/face/BotFace';
import { resolveBotFaceIdentity, type BotFaceStyle } from '@/components/sessions/bots/face/botFaceIdentity';

/** Stable sample Bot seeds, so every style's preview shows the same three Bots. */
const SAMPLE_BOTS = ['happier-sample-a', 'happier-sample-b', 'happier-sample-c'].map((seed) => ({
    seed,
    identity: resolveBotFaceIdentity(seed),
}));

/** The real Bot face in `style`, drawn for three sample Bots (still list forms). */
export const BotFaceStylePreview = React.memo(function BotFaceStylePreview(props: Readonly<{
    style: BotFaceStyle;
}>) {
    return (
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            {SAMPLE_BOTS.map((bot) => <BotFace key={bot.seed} identity={bot.identity} style={props.style} size={24} mood="quiet" />)}
        </View>
    );
});
