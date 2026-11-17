import * as React from 'react';

import { BotMotionSpecimen } from '@/components/dev/botFaces/BotMotionSpecimen';

/** Dev-only: every Bot state in each motion mode (lab R10 `r10-states`); reduced motion is the OS preference. */
export default function BotMotionDevScreen() {
    return <BotMotionSpecimen />;
}
