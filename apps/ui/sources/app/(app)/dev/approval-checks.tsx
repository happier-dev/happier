import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ApprovalChecksSpecimen } from '@/components/dev/approvals/ApprovalChecksSpecimen';
import { APPROVAL_CHECKS_PERSON_SCENES, APPROVAL_CHECKS_SCENES } from '@/dev/testkit/fixtures/approvalAutomaticChecksFixtures';

const PERSON_SCENES = Object.keys(APPROVAL_CHECKS_PERSON_SCENES) as (keyof typeof APPROVAL_CHECKS_PERSON_SCENES)[];

/**
 * Dev-only: approval cards held by before checks. `?scene=aconsent|achanged|…` shows one Agent card, none lists them
 * all; `?scene=pconsent|pchecking|prefused|pfailed|poverride` opens a person's own deploy in the in-place review.
 */
export default function ApprovalChecksDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    const scene = APPROVAL_CHECKS_SCENES.find((name) => name === params.scene)
        ?? PERSON_SCENES.find((name) => name === params.scene) ?? null;
    return <ApprovalChecksSpecimen scene={scene} />;
}
