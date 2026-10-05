/**
 * Names of the built-in workflows (FIN 08) as the protocol catalog keys them
 * (`workflows.builtins.*`). Mounted as `workflows.builtins` by `workflowTranslations.ts`.
 */

const en = {
    runsInsideSession: 'Runs inside a session',
    keepGoing: { title: 'Keep going until done' },
    reviewAndConverge: { title: 'Review & converge', apply: 'Apply', verifyAndFix: 'Verify and fix', verifyOnly: 'Verify only', rounds: 'Rounds before stopping' },
    planWithAPanel: { title: 'Plan with a panel', description: 'Several agents plan side by side, then the plan waits for your review.', inputs: { request: 'Request', requestPlaceholder: 'What should the panel plan?', engines: 'Planners' } },
    openAPullRequest: { title: 'Open a pull request', description: 'Asks for a second opinion, then opens a pull request. If the second opinion disagrees, it waits for you.', inputs: { base: 'Base branch', title: 'Pull request title', body: 'Description', question: 'Question for the second opinion' } },
};

type WorkflowBuiltinTranslations = typeof en;

const de: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Läuft in einer Sitzung',
    keepGoing: { title: 'Weitermachen bis fertig' },
    reviewAndConverge: { title: 'Prüfen & angleichen', apply: 'Anwenden', verifyAndFix: 'Prüfen und beheben', verifyOnly: 'Nur prüfen', rounds: 'Runden bis zum Stopp' },
    planWithAPanel: { title: 'Mit einem Gremium planen', description: 'Mehrere Agenten planen nebeneinander, dann wartet der Plan auf deine Prüfung.', inputs: { request: 'Anfrage', requestPlaceholder: 'Was soll das Gremium planen?', engines: 'Planende Agenten' } },
    openAPullRequest: { title: 'Pull-Request öffnen', description: 'Holt eine zweite Meinung ein und öffnet dann einen Pull-Request. Wenn die zweite Meinung widerspricht, wartet er auf dich.', inputs: { base: 'Basis-Branch', title: 'Titel des Pull-Requests', body: 'Beschreibung', question: 'Frage an die zweite Meinung' } },
};

const es: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Se ejecuta dentro de una sesión',
    keepGoing: { title: 'Seguir hasta terminar' },
    reviewAndConverge: { title: 'Revisar y converger', apply: 'Aplicar', verifyAndFix: 'Verificar y corregir', verifyOnly: 'Solo verificar', rounds: 'Rondas antes de parar' },
    planWithAPanel: { title: 'Planificar con un panel', description: 'Varios agentes planifican en paralelo y el plan espera tu revisión.', inputs: { request: 'Solicitud', requestPlaceholder: '¿Qué debe planificar el panel?', engines: 'Planificadores' } },
    openAPullRequest: { title: 'Abrir una pull request', description: 'Pide una segunda opinión y luego abre una pull request. Si la segunda opinión no está de acuerdo, te espera.', inputs: { base: 'Rama base', title: 'Título de la pull request', body: 'Descripción', question: 'Pregunta para la segunda opinión' } },
};

const fr: WorkflowBuiltinTranslations = {
    runsInsideSession: 'S’exécute dans une session',
    keepGoing: { title: 'Continuer jusqu’au bout' },
    reviewAndConverge: { title: 'Relire et converger', apply: 'Appliquer', verifyAndFix: 'Vérifier et corriger', verifyOnly: 'Vérifier uniquement', rounds: 'Tours avant l’arrêt' },
    planWithAPanel: { title: 'Planifier avec un panel', description: 'Plusieurs agents planifient côte à côte, puis le plan attend votre relecture.', inputs: { request: 'Demande', requestPlaceholder: 'Que doit planifier le panel ?', engines: 'Planificateurs' } },
    openAPullRequest: { title: 'Ouvrir une pull request', description: 'Demande un second avis, puis ouvre une pull request. Si le second avis n’est pas d’accord, il vous attend.', inputs: { base: 'Branche de base', title: 'Titre de la pull request', body: 'Description', question: 'Question pour le second avis' } },
};

const it: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Viene eseguito in una sessione',
    keepGoing: { title: 'Continua fino alla fine' },
    reviewAndConverge: { title: 'Revisiona e converge', apply: 'Applica', verifyAndFix: 'Verifica e correggi', verifyOnly: 'Solo verifica', rounds: 'Cicli prima di fermarsi' },
    planWithAPanel: { title: 'Pianifica con un panel', description: 'Più agenti pianificano affiancati, poi il piano attende la tua revisione.', inputs: { request: 'Richiesta', requestPlaceholder: 'Cosa deve pianificare il panel?', engines: 'Pianificatori' } },
    openAPullRequest: { title: 'Apri una pull request', description: 'Chiede un secondo parere, poi apre una pull request. Se il secondo parere non è d’accordo, ti aspetta.', inputs: { base: 'Branch di base', title: 'Titolo della pull request', body: 'Descrizione', question: 'Domanda per il secondo parere' } },
};

const pt: WorkflowBuiltinTranslations = {
    runsInsideSession: 'É executado numa sessão',
    keepGoing: { title: 'Continuar até terminar' },
    reviewAndConverge: { title: 'Rever e convergir', apply: 'Aplicar', verifyAndFix: 'Verificar e corrigir', verifyOnly: 'Apenas verificar', rounds: 'Rondas antes de parar' },
    planWithAPanel: { title: 'Planear com um painel', description: 'Vários agentes planeiam lado a lado e o plano aguarda a sua revisão.', inputs: { request: 'Pedido', requestPlaceholder: 'O que deve o painel planear?', engines: 'Planeadores' } },
    openAPullRequest: { title: 'Abrir um pull request', description: 'Pede uma segunda opinião e depois abre um pull request. Se a segunda opinião discordar, espera por si.', inputs: { base: 'Branch base', title: 'Título do pull request', body: 'Descrição', question: 'Pergunta para a segunda opinião' } },
};

const ca: WorkflowBuiltinTranslations = {
    runsInsideSession: 'S’executa dins d’una sessió',
    keepGoing: { title: 'Continua fins acabar' },
    reviewAndConverge: { title: 'Revisa i convergeix', apply: 'Aplica', verifyAndFix: 'Verifica i corregeix', verifyOnly: 'Només verifica', rounds: 'Rondes abans d’aturar-se' },
    planWithAPanel: { title: 'Planifica amb un panell', description: 'Diversos agents planifiquen en paral·lel i el pla espera la teva revisió.', inputs: { request: 'Petició', requestPlaceholder: 'Què ha de planificar el panell?', engines: 'Planificadors' } },
    openAPullRequest: { title: 'Obre una pull request', description: 'Demana una segona opinió i després obre una pull request. Si la segona opinió no hi està d’acord, t’espera.', inputs: { base: 'Branca base', title: 'Títol de la pull request', body: 'Descripció', question: 'Pregunta per a la segona opinió' } },
};

const pl: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Działa w sesji',
    keepGoing: { title: 'Kontynuuj do skutku' },
    reviewAndConverge: { title: 'Przejrzyj i uzgodnij', apply: 'Zastosuj', verifyAndFix: 'Sprawdź i napraw', verifyOnly: 'Tylko sprawdź', rounds: 'Rundy przed zatrzymaniem' },
    planWithAPanel: { title: 'Zaplanuj z panelem', description: 'Kilku agentów planuje obok siebie, a plan czeka na twój przegląd.', inputs: { request: 'Prośba', requestPlaceholder: 'Co ma zaplanować panel?', engines: 'Planujący' } },
    openAPullRequest: { title: 'Otwórz pull request', description: 'Prosi o drugą opinię, a potem otwiera pull request. Jeśli druga opinia się nie zgadza, czeka na ciebie.', inputs: { base: 'Gałąź bazowa', title: 'Tytuł pull requesta', body: 'Opis', question: 'Pytanie do drugiej opinii' } },
};

const ru: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Выполняется в сессии',
    keepGoing: { title: 'Продолжать до готовности' },
    reviewAndConverge: { title: 'Проверить и свести', apply: 'Применить', verifyAndFix: 'Проверить и исправить', verifyOnly: 'Только проверить', rounds: 'Раунды до остановки' },
    planWithAPanel: { title: 'Спланировать с панелью', description: 'Несколько агентов планируют параллельно, затем план ждёт вашей проверки.', inputs: { request: 'Запрос', requestPlaceholder: 'Что должна спланировать панель?', engines: 'Планировщики' } },
    openAPullRequest: { title: 'Открыть pull request', description: 'Запрашивает второе мнение, затем открывает pull request. Если второе мнение не согласно, ждёт вас.', inputs: { base: 'Базовая ветка', title: 'Заголовок pull request', body: 'Описание', question: 'Вопрос для второго мнения' } },
};

const ja: WorkflowBuiltinTranslations = {
    runsInsideSession: 'セッション内で実行',
    keepGoing: { title: '完了まで続ける' },
    reviewAndConverge: { title: 'レビューして収束', apply: '適用', verifyAndFix: '検証して修正', verifyOnly: '検証のみ', rounds: '停止までのラウンド数' },
    planWithAPanel: { title: 'パネルで計画', description: '複数のエージェントが並行して計画し、計画はあなたのレビューを待ちます。', inputs: { request: '依頼内容', requestPlaceholder: 'パネルに何を計画させますか？', engines: '計画するエージェント' } },
    openAPullRequest: { title: 'プルリクエストを開く', description: 'セカンドオピニオンを求めてからプルリクエストを開きます。意見が合わない場合はあなたを待ちます。', inputs: { base: 'ベースブランチ', title: 'プルリクエストのタイトル', body: '説明', question: 'セカンドオピニオンへの質問' } },
};

const zhHans: WorkflowBuiltinTranslations = {
    runsInsideSession: '在会话中运行',
    keepGoing: { title: '持续直到完成' },
    reviewAndConverge: { title: '审查并收敛', apply: '应用', verifyAndFix: '验证并修复', verifyOnly: '仅验证', rounds: '停止前的轮数' },
    planWithAPanel: { title: '由小组规划', description: '多个代理并行规划，然后计划等待你的审查。', inputs: { request: '请求', requestPlaceholder: '小组应规划什么？', engines: '规划者' } },
    openAPullRequest: { title: '打开拉取请求', description: '先征求第二意见，再打开拉取请求。如果第二意见不同意，它会等待你。', inputs: { base: '基础分支', title: '拉取请求标题', body: '描述', question: '给第二意见的问题' } },
};

const zhHant: WorkflowBuiltinTranslations = {
    runsInsideSession: '在工作階段中執行',
    keepGoing: { title: '持續直到完成' },
    reviewAndConverge: { title: '審查並收斂', apply: '套用', verifyAndFix: '驗證並修復', verifyOnly: '僅驗證', rounds: '停止前的輪數' },
    planWithAPanel: { title: '由小組規劃', description: '多個代理並行規劃，然後計畫等待你的審查。', inputs: { request: '請求', requestPlaceholder: '小組應規劃什麼？', engines: '規劃者' } },
    openAPullRequest: { title: '開啟提取請求', description: '先徵詢第二意見，再開啟提取請求。如果第二意見不同意，它會等待你。', inputs: { base: '基礎分支', title: '提取請求標題', body: '描述', question: '給第二意見的問題' } },
};

export const workflowBuiltinTranslations = {
    en,
    de,
    es,
    fr,
    it,
    pt,
    ca,
    pl,
    ru,
    ja,
    zhHans,
    zhHant,
} as const;
