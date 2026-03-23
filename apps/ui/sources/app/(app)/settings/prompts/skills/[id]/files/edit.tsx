import { useLocalSearchParams } from 'expo-router';

import { SkillBundleSupportingFileEditorScreen } from '@/components/settings/prompts/skills/SkillBundleSupportingFileEditorScreen';

export default function EditSkillSupportingFilePage() {
    const params = useLocalSearchParams<{ id: string; path?: string | string[] }>();
    const id = params.id;
    const path = Array.isArray(params.path) ? params.path[0] : params.path ?? null;
    if (!id) return null;
    return <SkillBundleSupportingFileEditorScreen artifactId={id} path={path} />;
}
