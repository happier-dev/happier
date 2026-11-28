import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export type GroupedQuestionResult = 'sent' | 'replaced' | 'unconfirmed' | Readonly<{ failure: string }>;

type ReadyQuestion = Readonly<{
    id: string;
    label: string;
    send: () => Promise<GroupedQuestionResult>;
}>;

function createReadyQuestionGroup() {
    const questions = new Map<object, ReadyQuestion>();
    const listeners = new Set<() => void>();
    let ready: readonly ReadyQuestion[] = [];
    function publish() {
        ready = [...questions.values()];
        listeners.forEach(listener => listener());
    }
    return {
        read: () => ready,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        register(key: object, question: ReadyQuestion) {
            questions.set(key, question);
            publish();
            return () => {
                questions.delete(key);
                publish();
            };
        },
    };
}

const QuestionGroup = React.createContext<ReturnType<typeof createReadyQuestionGroup> | null>(null);
export const QuestionGroupAsker = React.createContext<string | null>(null);

export function useGroupedQuestion(): boolean {
    return React.useContext(QuestionGroup) !== null;
}

export function ReadyQuestionEntry({ question, ready }: Readonly<{ question: ReadyQuestion; ready: boolean }>) {
    const group = React.useContext(QuestionGroup);
    const asker = React.useContext(QuestionGroupAsker);
    const ref = React.useRef(question);
    ref.current = question;
    const { id, label } = question;
    React.useLayoutEffect(() => {
        if (!group || !ready) return;
        return group.register(ref, { id, label: asker ? `${asker} · ${label}` : label,
            send: () => ref.current.id === id ? ref.current.send() : Promise.resolve('replaced') });
    }, [asker, group, id, label, ready]);
    return null;
}

export function QuestionSendGroup({ children }: React.PropsWithChildren) {
    const [group] = React.useState(createReadyQuestionGroup);
    return <QuestionGroup.Provider value={group}>{children}<QuestionSendGroupControls group={group} /></QuestionGroup.Provider>;
}

function QuestionSendGroupControls({ group }: Readonly<{ group: ReturnType<typeof createReadyQuestionGroup> }>) {
    const ready = React.useSyncExternalStore(group.subscribe, group.read, group.read);
    const sending = React.useRef(false);
    const [sendingCount, setSendingCount] = React.useState(0);
    const [results, setResults] = React.useState<readonly Readonly<{
        id: string; label: string; result: GroupedQuestionResult;
    }>[]>([]);
    const send = async () => {
        const sendingNow = group.read();
        if (sending.current || sendingNow.length === 0) return;
        sending.current = true;
        setSendingCount(sendingNow.length);
        try {
            setResults(await Promise.all(sendingNow.map(async ({ id, label, send }) => ({ id, label, result: await send() }))));
        } finally {
            sending.current = false;
            setSendingCount(0);
        }
    };
    return <>
        {ready.length > 0 || sendingCount > 0 ? <Item testID="question-group-send" title={t('sessionWork.questions.send', { count: sendingCount || ready.length })}
            disabled={sendingCount > 0} onPress={() => { void send(); }} /> : null}
        {results.map(({ id, label, result }) => <Item key={id} testID={`question-group-result:${id}`} title={label}
            subtitle={typeof result === 'string' ? t(`sessionWork.questions.${result}`) : result.failure} />)}
    </>;
}
