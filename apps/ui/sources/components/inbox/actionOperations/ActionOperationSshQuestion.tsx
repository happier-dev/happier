import * as React from 'react';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { confirmSshHostKey } from '@/components/ssh/SshHostKeyTrustSheet';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { t } from '@/text';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { useActionOperationTaskQuestion } from './useActionOperationTaskQuestion';

/** Prepare's guest trust uses the same host-key sheet as installation, inside its existing operation details. */
export function ActionOperationSshQuestion(props: Readonly<{ operation: QualifiedActionOperation }>) {
    const question = useActionOperationTaskQuestion(props.operation);
    const sheet = React.useRef<AbortController | null>(null);
    const [reviewing, setReviewing] = React.useState(false);
    const key = JSON.stringify(question.target);
    React.useEffect(() => () => { sheet.current?.abort(); }, [key]);
    const prompt = question.target?.prompt;
    if (!prompt || prompt.kind !== 'ssh.trustHost' && prompt.kind !== 'ssh.replaceHostKey') return null;
    const review = async () => {
        if (sheet.current) return;
        const controller = new AbortController();
        sheet.current = controller;
        setReviewing(true);
        try {
            const trusted = await confirmSshHostKey(prompt, { signal: controller.signal });
            if (!controller.signal.aborted) await question.respond({ trusted });
        } finally {
            if (sheet.current === controller) { sheet.current = null; setReviewing(false); }
        }
    };
    return <ItemGroup title={t('addFlows.hostKeyTitle')}>
        <Item mode="info" title={prompt.host} subtitle={question.failureCode
            ? resolveSystemTaskFailureMessage({ code: question.failureCode }) ?? t('common.error') : prompt.message}
            subtitleLines={0} showChevron={false} rightElement={<RoundButton title={t('approvals.review')}
                testID="action-operation-ssh-review" size="small" display="secondary" loading={question.pending || reviewing}
                disabled={question.pending || reviewing} onPress={() => { void review(); }} />} />
    </ItemGroup>;
}
