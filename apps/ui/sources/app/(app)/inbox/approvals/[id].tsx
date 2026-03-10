import * as React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';

import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import { t } from '@/text';

export default function ApprovalDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return null;

  const headerTitle = t('approvals.title');
  const screenOptions = React.useMemo(() => {
    return { title: headerTitle } as const;
  }, [headerTitle]);

  return (
    <>
      <Stack.Screen options={screenOptions} />
      <ApprovalDetailScreen artifactId={id} />
    </>
  );
}
