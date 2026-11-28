import * as React from 'react';
import type { ProjectDefinitionDetectionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';

export type RecognizedRepositoryFacts = Readonly<Pick<ProjectDefinitionDetectionV1, 'rootFiles' | 'environmentExample' | 'healthPath'> & {
    applications: NonNullable<ProjectDefinitionDetectionV1['applications']>;
    partial: boolean;
}>;

export type RecognizedRepositoryRead = Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'failed'; code: string }>
    | Readonly<{ status: 'ready'; facts: RecognizedRepositoryFacts }>;

const SECTION_ID = 'project-deployments.prepare.recognized';

export function DeploymentPreparationRecognized({ read, onRetry }: Readonly<{
    read: RecognizedRepositoryRead | null;
    onRetry?: () => void;
}>) {
    if (!read) return null;
    if (read.status === 'loading') return <ItemGroup testID={SECTION_ID} title={t('projects.deployments.preparation.recognized')}>
        <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
    </ItemGroup>;
    if (read.status === 'failed') return <ItemGroup testID={SECTION_ID} title={t('projects.deployments.preparation.recognized')}>
        <SurfaceStateCard testID={`${SECTION_ID}.failed`} size="line" kind="error" title={t('projects.deployments.unavailableTitle')}
            reason={deploymentActionRefusalRemedy(read.code)} diagnosticCode={read.code}
            action={onRetry ? { label: t('common.retry'), onPress: onRetry } : undefined} />
    </ItemGroup>;

    const { applications, rootFiles, environmentExample, healthPath, partial } = read.facts;
    const unknown = t('common.unknown');
    const files = [
        { key: 'dockerfile', label: 'Dockerfile', status: rootFiles?.dockerfile },
        { key: 'compose', label: 'Compose', status: rootFiles?.compose },
        { key: 'environment-example', label: '.env.example', status: environmentExample },
    ];
    return <ItemGroup testID={SECTION_ID} title={t('projects.deployments.preparation.recognized')}
        description={partial ? t('projects.deployments.preparation.recognizedPartial') : undefined}>
        {applications.length === 0 ? <Item testID={`${SECTION_ID}.none`} mode="info"
            title={t('projects.deployments.preparation.recognizedNone')} showChevron={false} /> : null}
        {applications.map(app => <Item key={app.file} testID={`${SECTION_ID}.${app.file}`} mode="info"
            title={app.file} subtitle={`${t('projects.deployments.preparation.framework')}: ${app.framework ?? unknown} · ${t('projects.deployments.preparation.runtime')}: ${app.runtime ? `${app.runtime.name} ${app.runtime.version}` : unknown}`}
            detail={app.port === null ? `${t('projects.deployments.preparation.listeningPort')}: ${unknown}`
                : t('projects.deployments.preparation.listensOn', { port: app.port })} showChevron={false} />)}
        <Item testID={`${SECTION_ID}.health-path`} mode="info" title={t('projects.deployments.preparation.healthPath')} detail={healthPath ?? unknown} />
        {files.map(file => <Item key={file.key} testID={`${SECTION_ID}.${file.key}`} mode="info" title={file.label}
            detail={file.status === 'present' ? t('projects.deployments.preparation.filePresent')
                : file.status === 'absent' ? t('projects.deployments.preparation.fileAbsent') : unknown} />)}
    </ItemGroup>;
}
