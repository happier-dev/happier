import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ApprovalChecksSpecimen } from '@/components/dev/approvals/ApprovalChecksSpecimen';
import { APPROVAL_CHECKS_SCENES } from '@/dev/testkit/fixtures/approvalAutomaticChecksFixtures';

/** Dev-only: Agent approval cards held by before checks. `?scene=aconsent|achanged|…` shows one; none lists all. */
export default function ApprovalChecksDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <ApprovalChecksSpecimen scene={APPROVAL_CHECKS_SCENES.find((scene) => scene === params.scene) ?? null} />;
}
