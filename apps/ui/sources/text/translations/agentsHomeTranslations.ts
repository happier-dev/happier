// The Agents root home (S30 §6.2, lab t:agents): its purpose, Needs you, the "Try another agent" shelf and the
// Models destination. Mounted under `capabilities.agentsHome`.

type Machine = Readonly<{ machine: string }>;

export type AgentsHomeTranslation = Readonly<{
  purpose: string;
  needsTitle: string;
  needsSignIn: (params: Machine) => string;
  tryTitle: string;
  tryBody: string;
  modelsTitle: string;
  modelsBody: string;
}>;

const en: AgentsHomeTranslation = {
  purpose:
    'The coding agents you start sessions with, where they’re installed and how they sign in.',
  needsTitle: 'Needs you',
  needsSignIn: ({ machine }) =>
    `Sessions on ${machine} can’t start until you sign in`,
  tryTitle: 'Try another agent',
  tryBody: 'Each one starts sessions like the agents you have.',
  modelsTitle: 'Models for your agents',
  modelsBody:
    'Providers give your agents more models: one key for many, or a model server on your machines.',
};

const ca: AgentsHomeTranslation = {
  purpose:
    'Els agents de codi amb què comences sessions, on estan instal·lats i com inicien la sessió.',
  needsTitle: 'Et necessita',
  needsSignIn: ({ machine }) =>
    `Les sessions a ${machine} no poden començar fins que iniciïs la sessió`,
  tryTitle: 'Prova un altre agent',
  tryBody: 'Cadascun comença sessions com els agents que ja tens.',
  modelsTitle: 'Models per als teus agents',
  modelsBody:
    'Els proveïdors donen més models als teus agents: una clau per a molts, o un servidor de models a les teves màquines.',
};

const de: AgentsHomeTranslation = {
  purpose:
    'Die Coding-Agents, mit denen du Sitzungen startest, wo sie installiert sind und wie sie sich anmelden.',
  needsTitle: 'Braucht dich',
  needsSignIn: ({ machine }) =>
    `Sitzungen auf ${machine} können erst starten, wenn du dich anmeldest`,
  tryTitle: 'Einen anderen Agent ausprobieren',
  tryBody: 'Jeder startet Sitzungen wie deine bisherigen Agents.',
  modelsTitle: 'Modelle für deine Agents',
  modelsBody:
    'Anbieter geben deinen Agents mehr Modelle: ein Schlüssel für viele oder ein Modellserver auf deinen Maschinen.',
};

const es: AgentsHomeTranslation = {
  purpose:
    'Los agentes de código con los que inicias sesiones, dónde están instalados y cómo inician sesión.',
  needsTitle: 'Te necesita',
  needsSignIn: ({ machine }) =>
    `Las sesiones en ${machine} no pueden empezar hasta que inicies sesión`,
  tryTitle: 'Prueba otro agente',
  tryBody: 'Cada uno inicia sesiones como los agentes que ya tienes.',
  modelsTitle: 'Modelos para tus agentes',
  modelsBody:
    'Los proveedores dan más modelos a tus agentes: una clave para muchos, o un servidor de modelos en tus máquinas.',
};

const fr: AgentsHomeTranslation = {
  purpose:
    'Les agents de code avec lesquels vous démarrez des sessions, où ils sont installés et comment ils se connectent.',
  needsTitle: 'Vous attend',
  needsSignIn: ({ machine }) =>
    `Les sessions sur ${machine} ne peuvent pas démarrer tant que vous ne vous connectez pas`,
  tryTitle: 'Essayer un autre agent',
  tryBody: 'Chacun démarre des sessions comme vos agents actuels.',
  modelsTitle: 'Modèles pour vos agents',
  modelsBody:
    'Les fournisseurs donnent plus de modèles à vos agents : une clé pour beaucoup, ou un serveur de modèles sur vos machines.',
};

const it: AgentsHomeTranslation = {
  purpose:
    'Gli agenti di codice con cui avvii le sessioni, dove sono installati e come accedono.',
  needsTitle: 'Ha bisogno di te',
  needsSignIn: ({ machine }) =>
    `Le sessioni su ${machine} non possono partire finché non accedi`,
  tryTitle: 'Prova un altro agente',
  tryBody: 'Ognuno avvia sessioni come gli agenti che hai già.',
  modelsTitle: 'Modelli per i tuoi agenti',
  modelsBody:
    'I provider danno ai tuoi agenti più modelli: una chiave per molti, o un server di modelli sulle tue macchine.',
};

const ja: AgentsHomeTranslation = {
  purpose:
    'セッションを始めるコーディングエージェント、そのインストール先とサインイン方法。',
  needsTitle: '対応が必要',
  needsSignIn: ({ machine }) =>
    `サインインするまで ${machine} のセッションは開始できません`,
  tryTitle: 'ほかのエージェントを試す',
  tryBody: 'どれも今のエージェントと同じようにセッションを始められます。',
  modelsTitle: 'エージェントのモデル',
  modelsBody:
    'プロバイダーでエージェントのモデルが増えます。1 つのキーで多くのモデル、またはマシン上のモデルサーバー。',
};

const pl: AgentsHomeTranslation = {
  purpose:
    'Agenci kodujący, z którymi zaczynasz sesje, gdzie są zainstalowani i jak się logują.',
  needsTitle: 'Potrzebuje ciebie',
  needsSignIn: ({ machine }) =>
    `Sesje na ${machine} nie mogą się zacząć, dopóki się nie zalogujesz`,
  tryTitle: 'Wypróbuj innego agenta',
  tryBody: 'Każdy zaczyna sesje tak jak agenci, których już masz.',
  modelsTitle: 'Modele dla twoich agentów',
  modelsBody:
    'Dostawcy dają twoim agentom więcej modeli: jeden klucz do wielu albo serwer modeli na twoich maszynach.',
};

const pt: AgentsHomeTranslation = {
  purpose:
    'Os agentes de código com que inicias sessões, onde estão instalados e como iniciam sessão.',
  needsTitle: 'Precisa de ti',
  needsSignIn: ({ machine }) =>
    `As sessões em ${machine} não podem começar até iniciares sessão`,
  tryTitle: 'Experimenta outro agente',
  tryBody: 'Cada um inicia sessões como os agentes que já tens.',
  modelsTitle: 'Modelos para os teus agentes',
  modelsBody:
    'Os fornecedores dão mais modelos aos teus agentes: uma chave para muitos, ou um servidor de modelos nas tuas máquinas.',
};

const ru: AgentsHomeTranslation = {
  purpose:
    'Агенты для кода, с которыми вы начинаете сессии: где они установлены и как входят в аккаунт.',
  needsTitle: 'Нужно ваше участие',
  needsSignIn: ({ machine }) =>
    `Сессии на ${machine} не начнутся, пока вы не войдёте`,
  tryTitle: 'Попробуйте другого агента',
  tryBody: 'Каждый начинает сессии так же, как ваши агенты.',
  modelsTitle: 'Модели для ваших агентов',
  modelsBody:
    'Провайдеры дают агентам больше моделей: один ключ для многих или сервер моделей на ваших машинах.',
};

const zhHans: AgentsHomeTranslation = {
  purpose: '你用来开始会话的编程代理：安装在哪里，以及如何登录。',
  needsTitle: '需要你处理',
  needsSignIn: ({ machine }) => `登录之前，${machine} 上的会话无法开始`,
  tryTitle: '试试其他代理',
  tryBody: '每个代理都能像你现有的代理一样开始会话。',
  modelsTitle: '代理可用的模型',
  modelsBody:
    '提供方为你的代理带来更多模型：一个密钥用于多个模型，或在你的机器上运行模型服务器。',
};

const zhHant: AgentsHomeTranslation = {
  purpose: '你用來開始工作階段的程式代理：安裝在哪裡，以及如何登入。',
  needsTitle: '需要你處理',
  needsSignIn: ({ machine }) => `登入之前，${machine} 上的工作階段無法開始`,
  tryTitle: '試試其他代理',
  tryBody: '每個代理都能像你現有的代理一樣開始工作階段。',
  modelsTitle: '代理可用的模型',
  modelsBody:
    '供應商為你的代理帶來更多模型：一把金鑰用於多個模型，或在你的機器上執行模型伺服器。',
};

export const agentsHomeTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  zhHans,
  zhHant,
} as const satisfies Record<string, AgentsHomeTranslation>;
