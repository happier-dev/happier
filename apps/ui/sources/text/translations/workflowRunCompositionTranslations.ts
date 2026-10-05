const en = {
    runWithAnotherAgent: 'Run again with another agent',
    agentForStep: ({ step }: { step: string }) => `Agent for ${step}`,
    chooseAgent: 'Choose an agent or role',
};
export const workflowRunCompositionTranslations: Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en> = {
    en,
    de: { runWithAnotherAgent: 'Mit anderem Agenten erneut ausführen', agentForStep: ({ step }) => `Agent für ${step}`, chooseAgent: 'Agent oder Rolle wählen' },
    es: { runWithAnotherAgent: 'Ejecutar de nuevo con otro agente', agentForStep: ({ step }) => `Agente para ${step}`, chooseAgent: 'Elegir un agente o rol' },
    fr: { runWithAnotherAgent: 'Relancer avec un autre agent', agentForStep: ({ step }) => `Agent pour ${step}`, chooseAgent: 'Choisir un agent ou un rôle' },
    it: { runWithAnotherAgent: 'Esegui di nuovo con un altro agente', agentForStep: ({ step }) => `Agente per ${step}`, chooseAgent: 'Scegli un agente o un ruolo' },
    pt: { runWithAnotherAgent: 'Executar novamente com outro agente', agentForStep: ({ step }) => `Agente para ${step}`, chooseAgent: 'Escolher um agente ou papel' },
    ca: { runWithAnotherAgent: 'Torna a executar amb un altre agent', agentForStep: ({ step }) => `Agent per a ${step}`, chooseAgent: 'Tria un agent o rol' },
    pl: { runWithAnotherAgent: 'Uruchom ponownie z innym agentem', agentForStep: ({ step }) => `Agent dla ${step}`, chooseAgent: 'Wybierz agenta lub rolę' },
    ru: { runWithAnotherAgent: 'Запустить снова с другим агентом', agentForStep: ({ step }) => `Агент для ${step}`, chooseAgent: 'Выберите агента или роль' },
    ja: { runWithAnotherAgent: '別のエージェントで再実行', agentForStep: ({ step }) => `${step}のエージェント`, chooseAgent: 'エージェントまたはロールを選択' },
    zhHans: { runWithAnotherAgent: '用另一个代理再次运行', agentForStep: ({ step }) => `${step}的代理`, chooseAgent: '选择代理或角色' },
    zhHant: { runWithAnotherAgent: '用另一個代理再次執行', agentForStep: ({ step }) => `${step}的代理`, chooseAgent: '選擇代理或角色' },
};
