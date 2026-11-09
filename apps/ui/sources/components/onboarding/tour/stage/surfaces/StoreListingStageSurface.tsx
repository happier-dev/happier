import * as React from 'react';

import { CapabilityListingDetail, type CapabilityListingConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { SkillAddDetailView, type SkillAddDetailPlaces } from '@/components/settings/skills/add/SkillAddDetailBody';
import { skillPlanOnMachine } from '@/components/settings/skills/skillsCollectionModel';
import { StoreListingPageFrame } from '@/components/store/StoreListing';
import { buildDemoSkillMachines, buildDemoSkillsLibrary, DEMO_REVIEW_SKILL_INSTRUCTIONS } from '@/demoMode/world/skills';
import { t } from '@/text';

import type { StageDevice } from '../DeviceFrame';

const noop = () => {};
type Skill = ReturnType<typeof buildDemoSkillsLibrary>['items'][number];

/** The actual skill listing view, showing an already-held personal demo skill. */
export function StoreListingStageSurface(props: Readonly<{ device: StageDevice; installResult?: boolean }>): React.ReactElement {
    const item = React.useMemo(() => buildDemoSkillsLibrary().items[0]!, []);
    const places = React.useMemo<SkillAddDetailPlaces>(() => {
        const machines = buildDemoSkillMachines();
        return {
            machines, workspaceRefs: [], projects: [], agentIds: machines[0]!.agentIds,
            placeMachines: machines.map(machine => ({ machineId: machine.machineId, name: machine.name!, online: machine.online })),
            agentTakes: agentId => {
                const kind = skillPlanOnMachine(machines[0]!, agentId);
                return kind === 'session_dir' ? 'full' : kind;
            },
        };
    }, []);
    const config = React.useMemo<CapabilityListingConfig<Skill>>(() => ({
        catalog: { itemKey: skill => skill.skillId },
        testID: 'demo-store-skill-listing',
        renderDetail: skill => <SkillAddDetailView title={skill.name} purpose={skill.description} places={places}
            facts={{ presentation: 'row', trust: skill.trust, cost: { tokensWhenUsed: skill.cost.bodyTokens }, source: { kind: 'you' } }}
            installs={{ trust: skill.trust, scripts: 0, files: [{ path: 'SKILL.md', size: DEMO_REVIEW_SKILL_INSTRUCTIONS.length }], cost: skill.cost }}
            outsideReferences={[]} savedRules={skill.rules} instructions={DEMO_REVIEW_SKILL_INSTRUCTIONS}
            onWhereChange={noop} testID="demo-store-skill-listing.detail" />,
        detailFooter: () => props.installResult ? {
            // Only a local demonstration result: no install Action or Machine mutation is issued.
            primary: { label: t('capabilities.skillAdd.addToLibrary'), onPress: async () => ({ itemId: item.skillId, then: 'stay' }) },
            afterAdd: { open: { label: t('capabilities.skillAdd.open'), onPress: noop }, onDone: noop },
        } : { primary: { label: t('capabilities.skillAdd.open'), onPress: async () => null } },
    }), [item.skillId, places, props.installResult]);
    const listing = <CapabilityListingDetail config={config} item={item} onClose={noop} pushed={props.device === 'phone'} />;
    return props.device === 'phone' ? <StoreListingPageFrame>{listing}</StoreListingPageFrame> : listing;
}

/** Capture clicks Add to reach the listing owner's actual successful-result state. */
export function StoreInstallResultStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    return <StoreListingStageSurface device={props.device} installResult />;
}
