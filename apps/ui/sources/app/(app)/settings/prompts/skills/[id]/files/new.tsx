import { useLocalSearchParams } from 'expo-router';

import { SkillBundleSupportingFileEditorScreen } from '@/components/settings/prompts/skills/SkillBundleSupportingFileEditorScreen';

export default function NewSkillSupportingFilePage() {
    const { id } = useLocalSearchParams<{ id: string }>();
    if (!id) return null;
    return <SkillBundleSupportingFileEditorScreen artifactId={id} path={null} />;
}
