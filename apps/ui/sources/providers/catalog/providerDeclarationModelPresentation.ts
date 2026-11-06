import type { ProviderDeclarationDetail } from './providerDeclarationDetail';
import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';
import { t } from '@/text';

const MODELS_NAMED = 3;

/** The same declared-model facts in Add details and the consequence review; never a live model probe. */
export function presentProviderDeclarationModels(name: string, models: ProviderDeclarationDetail['models']): Readonly<{
    title: string;
    subtitle?: string;
}> {
    if (models.source === 'manual') return { title: t('settingsProvidersCollection.addDetail.modelsManual') };
    const declared = 'staticModels' in models ? models.staticModels : [];
    return {
        title: declared.length === 0 ? t('settingsProvidersCollection.addDetail.modelsOnConnect')
            : t(models.source === 'static+probe' ? 'settingsProvidersCollection.addDetail.modelsCountMore'
                : 'settingsProvidersCollection.addDetail.modelsCount', { count: declared.length }),
        subtitle: declared.length === 0 ? t('settingsProvidersCollection.addDetail.modelsReadFrom', { provider: name })
            : formatAgentNameList([
                ...declared.slice(0, MODELS_NAMED).map(model => model.name),
                ...(declared.length > MODELS_NAMED ? [t('capabilities.where.more', { count: declared.length - MODELS_NAMED })] : []),
            ]),
    };
}
