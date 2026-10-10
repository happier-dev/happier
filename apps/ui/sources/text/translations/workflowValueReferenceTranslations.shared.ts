


export type WorkflowValueReferenceCopy = {
    checkoutRoot: string;
    unavailableValue: string;
    sessionContext: (params: { turns: number }) => string;
    tokensUsed: string;
    goalTokenBudget: string;
    trailingCount: (params: { source: string; value: string }) => string;
    stopCondition: string;
    stopConditionArm: (params: { arm: number }) => string;
    roundLimit: (params: { rounds: number }) => string;
    decision: string;
};

export const workflowValueReferenceTranslationsEnglish = { en: {
        checkoutRoot: 'Checkout root folder',
        unavailableValue: 'Unavailable value', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Session context' : turns === 1 ? 'Last session turn' : `Last ${turns} session turns`,
        tokensUsed: 'Tokens used', goalTokenBudget: 'Goal token budget',
        trailingCount: ({ source, value }: { source: string; value: string }) => `Consecutive ${source} matching ${value}`,
        stopCondition: 'Stop condition met', stopConditionArm: ({ arm }: { arm: number }) => `Stop condition ${arm} met`,
        roundLimit: ({ rounds }: { rounds: number }) => `Round limit reached · ${rounds} rounds`, decision: 'Decision',
    } };
