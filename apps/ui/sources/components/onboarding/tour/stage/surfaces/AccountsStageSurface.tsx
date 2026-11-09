import * as React from 'react';

import { QualifiedPoolDetailView, type QualifiedPoolDetailMutations } from '@/components/settings/connectedServices/pools/QualifiedPoolDetailView';
import { buildDemoAccountPool } from '@/demoMode/world/accountPool';

const unchanged = async () => null;
const MUTATIONS: QualifiedPoolDetailMutations = {
    mutating: false, patch: unchanged, patchMember: unchanged, addMember: unchanged,
    removeMember: unchanged, setActiveAccount: unchanged, delete: async () => false,
};

/** The real pool detail over synthetic accounts; mutations never leave the stage. */
export function AccountsStageSurface(): React.ReactElement {
    const pool = React.useMemo(buildDemoAccountPool, []);
    return <QualifiedPoolDetailView {...pool} serviceLabel="ChatGPT" mutations={MUTATIONS} />;
}
