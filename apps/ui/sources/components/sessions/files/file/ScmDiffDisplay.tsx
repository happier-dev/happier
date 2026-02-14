import * as React from 'react';
import { View } from 'react-native';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';

type ScmDiffDisplayProps = Readonly<{
  diffContent: string | null | undefined;
}>;

export function ScmDiffDisplay(props: ScmDiffDisplayProps) {
  const lines = React.useMemo(() => {
    return buildCodeLinesFromUnifiedDiff({ unifiedDiff: props.diffContent ?? '' });
  }, [props.diffContent]);

  return (
    <View>
      <CodeLinesView lines={lines} />
    </View>
  );
}
