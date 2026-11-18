type Count = Readonly<{ count: number }>;
type More = Readonly<{ first: string; count: number }>;

/** The Discussion menu's check-in row (a positive switch: on keeps agents going here, F11) and the composer's Send to chip (C3 DISC-17, DISC-18). */
export const discussionControlsCopy = {
  en: {
    incomingMessage: 'Incoming message',
    keepGoing: 'Keep agents going here',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Follows your setting: pauses after 1 turn'
        : `Follows your setting: pauses after ${count} turns`,
    inheritsNever: 'Follows your setting: never pauses',
    neverHere: 'Agents keep going here until you stop them',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Pauses here after 1 turn'
        : `Pauses here after ${count} turns`,
    unavailable: 'This setting can’t be read right now',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'All',
    whoFilterSessions: 'Sessions',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'People',
    whoFilterEngines: 'Engines',
    whoSearch: 'Search Sessions, bots and people',
    whoSearchWithEngines: 'Search Sessions, bots, people and engines',
    addAgentLine: 'Pick its agent, model, Machine and folder',
  },
  ca: {
    incomingMessage: 'Missatge entrant',
    keepGoing: 'Mantén els agents en marxa aquí',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segueix la teva configuració: s’atura després d’1 torn'
        : `Segueix la teva configuració: s’atura després de ${count} torns`,
    inheritsNever: 'Segueix la teva configuració: no s’atura mai',
    neverHere: 'Aquí els agents continuen fins que els aturis',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aquí s’atura després d’1 torn'
        : `Aquí s’atura després de ${count} torns`,
    unavailable: 'Ara no es pot llegir aquesta configuració',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Tot',
    whoFilterSessions: 'Sessions',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'Persones',
    whoFilterEngines: 'Motors',
    whoSearch: 'Cerca sessions, bots i persones',
    whoSearchWithEngines: 'Cerca sessions, bots, persones i motors',
    addAgentLine: 'Tria’n l’agent, el model, la màquina i la carpeta',
  },
  de: {
    incomingMessage: 'Eingehende Nachricht',
    keepGoing: 'Agenten hier weiterlaufen lassen',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Folgt deiner Einstellung: pausiert nach 1 Zug'
        : `Folgt deiner Einstellung: pausiert nach ${count} Zügen`,
    inheritsNever: 'Folgt deiner Einstellung: pausiert nie',
    neverHere: 'Agenten machen hier weiter, bis du sie stoppst',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Pausiert hier nach 1 Zug'
        : `Pausiert hier nach ${count} Zügen`,
    unavailable: 'Diese Einstellung kann gerade nicht gelesen werden',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Alle',
    whoFilterSessions: 'Sitzungen',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'Personen',
    whoFilterEngines: 'Engines',
    whoSearch: 'Sitzungen, Bots und Personen suchen',
    whoSearchWithEngines: 'Sitzungen, Bots, Personen und Engines suchen',
    addAgentLine: 'Agent, Modell, Rechner und Ordner wählen',
  },
  es: {
    incomingMessage: 'Mensaje entrante',
    keepGoing: 'Mantener a los agentes en marcha aquí',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Sigue tu ajuste: se pausa tras 1 turno'
        : `Sigue tu ajuste: se pausa tras ${count} turnos`,
    inheritsNever: 'Sigue tu ajuste: nunca se pausa',
    neverHere: 'Aquí los agentes siguen hasta que los detengas',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aquí se pausa tras 1 turno'
        : `Aquí se pausa tras ${count} turnos`,
    unavailable: 'Ahora no se puede leer este ajuste',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Todo',
    whoFilterSessions: 'Sesiones',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'Personas',
    whoFilterEngines: 'Motores',
    whoSearch: 'Buscar sesiones, bots y personas',
    whoSearchWithEngines: 'Buscar sesiones, bots, personas y motores',
    addAgentLine: 'Elige su agente, modelo, máquina y carpeta',
  },
  fr: {
    incomingMessage: 'Message entrant',
    keepGoing: 'Laisser les agents continuer ici',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Suit votre réglage : pause après 1 tour'
        : `Suit votre réglage : pause après ${count} tours`,
    inheritsNever: 'Suit votre réglage : jamais de pause',
    neverHere: 'Ici, les agents continuent jusqu’à ce que vous les arrêtiez',
    turnsHere: ({ count }: Count) =>
      count === 1 ? 'Pause ici après 1 tour' : `Pause ici après ${count} tours`,
    unavailable: 'Ce réglage ne peut pas être lu pour le moment',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Tout',
    whoFilterSessions: 'Sessions',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'Personnes',
    whoFilterEngines: 'Moteurs',
    whoSearch: 'Rechercher des sessions, bots et personnes',
    whoSearchWithEngines: 'Rechercher des sessions, bots, personnes et moteurs',
    addAgentLine: 'Choisissez son agent, son modèle, sa machine et son dossier',
  },
  it: {
    incomingMessage: 'Messaggio in arrivo',
    keepGoing: 'Lascia che gli agenti continuino qui',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segue la tua impostazione: pausa dopo 1 turno'
        : `Segue la tua impostazione: pausa dopo ${count} turni`,
    inheritsNever: 'Segue la tua impostazione: mai in pausa',
    neverHere: 'Qui gli agenti continuano finché non li fermi',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Qui va in pausa dopo 1 turno'
        : `Qui va in pausa dopo ${count} turni`,
    unavailable: 'Al momento questa impostazione non è leggibile',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Tutto',
    whoFilterSessions: 'Sessioni',
    whoFilterBots: 'Bot',
    whoFilterPeople: 'Persone',
    whoFilterEngines: 'Motori',
    whoSearch: 'Cerca sessioni, bot e persone',
    whoSearchWithEngines: 'Cerca sessioni, bot, persone e motori',
    addAgentLine: 'Scegli agente, modello, macchina e cartella',
  },
  ja: {
    incomingMessage: '受信メッセージ',
    keepGoing: 'ここでは Agent を続行させる',
    inheritsTurns: ({ count }: Count) =>
      `設定に従う：${count} ターン後に一時停止`,
    inheritsNever: '設定に従う：一時停止しない',
    neverHere: 'ここではあなたが止めるまでエージェントが続けます',
    turnsHere: ({ count }: Count) => `ここでは ${count} ターン後に一時停止`,
    unavailable: '現在この設定を読み込めません',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'すべて',
    whoFilterSessions: 'セッション',
    whoFilterBots: 'ボット',
    whoFilterPeople: 'メンバー',
    whoFilterEngines: 'エンジン',
    whoSearch: 'セッション、ボット、メンバーを検索',
    whoSearchWithEngines: 'セッション、ボット、メンバー、エンジンを検索',
    addAgentLine: 'エージェント、モデル、マシン、フォルダーを選択',
  },
  pl: {
    incomingMessage: 'Wiadomość przychodząca',
    keepGoing: 'Pozwól agentom działać tu dalej',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Według Twojego ustawienia: pauza po 1 turze'
        : `Według Twojego ustawienia: pauza po ${count} turach`,
    inheritsNever: 'Według Twojego ustawienia: bez pauzy',
    neverHere: 'Tutaj agenci działają, dopóki ich nie zatrzymasz',
    turnsHere: ({ count }: Count) =>
      count === 1 ? 'Tutaj pauza po 1 turze' : `Tutaj pauza po ${count} turach`,
    unavailable: 'Nie można teraz odczytać tego ustawienia',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Wszystko',
    whoFilterSessions: 'Sesje',
    whoFilterBots: 'Boty',
    whoFilterPeople: 'Osoby',
    whoFilterEngines: 'Silniki',
    whoSearch: 'Szukaj sesji, botów i osób',
    whoSearchWithEngines: 'Szukaj sesji, botów, osób i silników',
    addAgentLine: 'Wybierz agenta, model, maszynę i folder',
  },
  pt: {
    incomingMessage: 'Mensagem recebida',
    keepGoing: 'Manter os agentes a trabalhar aqui',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segue sua configuração: pausa após 1 turno'
        : `Segue sua configuração: pausa após ${count} turnos`,
    inheritsNever: 'Segue sua configuração: nunca pausa',
    neverHere: 'Aqui os agentes continuam até você pará-los',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aqui pausa após 1 turno'
        : `Aqui pausa após ${count} turnos`,
    unavailable: 'Não é possível ler esta configuração agora',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Tudo',
    whoFilterSessions: 'Sessões',
    whoFilterBots: 'Bots',
    whoFilterPeople: 'Pessoas',
    whoFilterEngines: 'Motores',
    whoSearch: 'Pesquisar sessões, bots e pessoas',
    whoSearchWithEngines: 'Pesquisar sessões, bots, pessoas e motores',
    addAgentLine: 'Escolha o agente, o modelo, a máquina e a pasta',
  },
  ru: {
    incomingMessage: 'Входящее сообщение',
    keepGoing: 'Агенты здесь работают без пауз',
    inheritsTurns: ({ count }: Count) =>
      `По вашей настройке: пауза после ходов: ${count}`,
    inheritsNever: 'По вашей настройке: без пауз',
    neverHere: 'Здесь агенты продолжают, пока вы их не остановите',
    turnsHere: ({ count }: Count) => `Здесь пауза после ходов: ${count}`,
    unavailable: 'Сейчас не удаётся прочитать эту настройку',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: 'Все',
    whoFilterSessions: 'Сессии',
    whoFilterBots: 'Боты',
    whoFilterPeople: 'Люди',
    whoFilterEngines: 'Движки',
    whoSearch: 'Искать сессии, ботов и людей',
    whoSearchWithEngines: 'Искать сессии, ботов, людей и движки',
    addAgentLine: 'Выберите агента, модель, машину и папку',
  },
  'zh-Hans': {
    incomingMessage: '收到的消息',
    keepGoing: '让 Agent 在这里持续运行',
    inheritsTurns: ({ count }: Count) => `沿用你的设置：${count} 轮后暂停`,
    inheritsNever: '沿用你的设置：从不暂停',
    neverHere: '在这里，智能体会一直继续，直到你停止它们',
    turnsHere: ({ count }: Count) => `在这里 ${count} 轮后暂停`,
    unavailable: '暂时无法读取此设置',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: '全部',
    whoFilterSessions: '会话',
    whoFilterBots: '机器人',
    whoFilterPeople: '成员',
    whoFilterEngines: '引擎',
    whoSearch: '搜索会话、机器人和成员',
    whoSearchWithEngines: '搜索会话、机器人、成员和引擎',
    addAgentLine: '选择它的智能体、模型、机器和文件夹',
  },
  'zh-Hant': {
    incomingMessage: '收到的訊息',
    keepGoing: '讓 Agent 在這裡持續執行',
    inheritsTurns: ({ count }: Count) => `沿用你的設定：${count} 輪後暫停`,
    inheritsNever: '沿用你的設定：永不暫停',
    neverHere: '在這裡，代理會一直繼續，直到你停止它們',
    turnsHere: ({ count }: Count) => `在這裡 ${count} 輪後暫停`,
    unavailable: '暫時無法讀取此設定',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
    whoFilterAll: '全部',
    whoFilterSessions: '工作階段',
    whoFilterBots: '機器人',
    whoFilterPeople: '成員',
    whoFilterEngines: '引擎',
    whoSearch: '搜尋工作階段、機器人和成員',
    whoSearchWithEngines: '搜尋工作階段、機器人、成員和引擎',
    addAgentLine: '選擇它的代理、模型、機器和資料夾',
  },
};
