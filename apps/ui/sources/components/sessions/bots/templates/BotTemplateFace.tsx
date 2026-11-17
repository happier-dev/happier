import * as React from 'react';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

import { PortablePetFace } from '@/components/sessions/bots/face/PortablePetFace';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';

/**
 * A template's face wherever the template itself is shown (header, What you get): the pet that travels with it when it
 * has one, otherwise its seeded face. Still, as every template identity is.
 */
export function BotTemplateFace(props: Readonly<{
    identity: BotTemplateContentV1['identity'];
    pet?: BotTemplateContentV1['pet'];
    size: number;
}>) {
    const face = props.identity.face ?? null;
    return props.pet
        ? <PortablePetFace pet={props.pet} seed={props.identity.name} face={face} size={props.size} motion={false} />
        : <SessionBotFace facts={{ seed: props.identity.name, face }} size={props.size} motion={false} />;
}
