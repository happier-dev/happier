import type { SupportedLanguage } from '../_all';

/**
 * What a new Environment takes from the creation defaults, and where each value came from. One copy for every
 * review that shows the canonical resolver's values and sources (the Environment draft and the Store App).
 */
type DeploymentCreationReviewCopy = Readonly<{
  title: string;
  description: string;
  create: string;
  buildsOn: (params: { machine: string }) => string;
  deploysFrom: (params: { machine: string }) => string;
  keepsPrevious: (params: { count: number }) => string;
  fromExplicit: string;
  fromProject: string;
  fromAccount: string;
  fromBuiltin: string;
}>;

export const deploymentCreationReviewTranslations = {
  en: {
    title: 'How it deploys',
    description:
      'Check these before you create it.',
    create: 'Create environment',
    buildsOn: ({ machine }) => `Builds on ${machine}`,
    deploysFrom: ({ machine }) => `Deploys run from ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Keeps no previous versions for rollback'
        : count === 1
          ? 'Keeps 1 previous version for rollback'
          : `Keeps ${count} previous versions for rollback`,
    fromExplicit: 'You chose this',
    fromProject: 'From the project',
    fromAccount: 'From your Account',
    fromBuiltin: 'Happier’s default',
  },
  ca: {
    title: 'Com es desplega',
    description:
      'Revisa’ls abans de crear-lo.',
    create: 'Crea l’entorn',
    buildsOn: ({ machine }) => `Es construeix a ${machine}`,
    deploysFrom: ({ machine }) =>
      `Els desplegaments s’executen des de ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'No conserva cap versió anterior per desfer'
        : count === 1
          ? 'Conserva 1 versió anterior per desfer'
          : `Conserva ${count} versions anteriors per desfer`,
    fromExplicit: 'Ho has triat tu',
    fromProject: 'Del projecte',
    fromAccount: 'Del teu compte',
    fromBuiltin: 'Valor per defecte de Happier',
  },
  de: {
    title: 'So wird bereitgestellt',
    description:
      'Prüfe diese Werte, bevor du die Umgebung erstellst.',
    create: 'Umgebung erstellen',
    buildsOn: ({ machine }) => `Baut auf ${machine}`,
    deploysFrom: ({ machine }) => `Bereitstellungen laufen von ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Behält keine früheren Versionen zum Zurücksetzen'
        : count === 1
          ? 'Behält 1 frühere Version zum Zurücksetzen'
          : `Behält ${count} frühere Versionen zum Zurücksetzen`,
    fromExplicit: 'Von dir gewählt',
    fromProject: 'Aus dem Projekt',
    fromAccount: 'Aus deinem Konto',
    fromBuiltin: 'Happiers Standard',
  },
  es: {
    title: 'Cómo se despliega',
    description:
      'Revísalos antes de crearlo.',
    create: 'Crear entorno',
    buildsOn: ({ machine }) => `Se compila en ${machine}`,
    deploysFrom: ({ machine }) =>
      `Los despliegues se ejecutan desde ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'No conserva versiones anteriores para revertir'
        : count === 1
          ? 'Conserva 1 versión anterior para revertir'
          : `Conserva ${count} versiones anteriores para revertir`,
    fromExplicit: 'Lo elegiste tú',
    fromProject: 'Del proyecto',
    fromAccount: 'De tu cuenta',
    fromBuiltin: 'Valor por defecto de Happier',
  },
  fr: {
    title: 'Comment il se déploie',
    description:
      'Vérifie-les avant de le créer.',
    create: 'Créer l’environnement',
    buildsOn: ({ machine }) => `Se construit sur ${machine}`,
    deploysFrom: ({ machine }) => `Les déploiements partent de ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Ne garde aucune version précédente pour revenir en arrière'
        : count === 1
          ? 'Garde 1 version précédente pour revenir en arrière'
          : `Garde ${count} versions précédentes pour revenir en arrière`,
    fromExplicit: 'Tu l’as choisi',
    fromProject: 'Du projet',
    fromAccount: 'De ton compte',
    fromBuiltin: 'Valeur par défaut de Happier',
  },
  it: {
    title: 'Come viene distribuito',
    description:
      'Controllali prima di crearlo.',
    create: 'Crea ambiente',
    buildsOn: ({ machine }) => `Compila su ${machine}`,
    deploysFrom: ({ machine }) => `Le distribuzioni partono da ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Non conserva versioni precedenti per il ripristino'
        : count === 1
          ? 'Conserva 1 versione precedente per il ripristino'
          : `Conserva ${count} versioni precedenti per il ripristino`,
    fromExplicit: 'Scelto da te',
    fromProject: 'Dal progetto',
    fromAccount: 'Dal tuo account',
    fromBuiltin: 'Predefinito di Happier',
  },
  ja: {
    title: 'デプロイのしかた',
    description: '作成する前に確認してください。',
    create: '環境を作成',
    buildsOn: ({ machine }) => `${machine} でビルド`,
    deploysFrom: ({ machine }) => `${machine} からデプロイ`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'ロールバック用の以前のバージョンは保持しません'
        : `ロールバック用に以前のバージョンを ${count} 個保持`,
    fromExplicit: 'あなたが選択',
    fromProject: 'プロジェクトから',
    fromAccount: 'アカウントから',
    fromBuiltin: 'Happier の既定',
  },
  pl: {
    title: 'Jak jest wdrażane',
    description:
      'Sprawdź je przed utworzeniem.',
    create: 'Utwórz środowisko',
    buildsOn: ({ machine }) => `Budowane na ${machine}`,
    deploysFrom: ({ machine }) => `Wdrożenia działają z ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Nie zachowuje poprzednich wersji do wycofania'
        : count === 1
          ? 'Zachowuje 1 poprzednią wersję do wycofania'
          : `Zachowuje poprzednie wersje (${count}) do wycofania`,
    fromExplicit: 'Twój wybór',
    fromProject: 'Z projektu',
    fromAccount: 'Z twojego konta',
    fromBuiltin: 'Domyślne Happier',
  },
  pt: {
    title: 'Como é implementado',
    description: 'Revê-os antes de o criar.',
    create: 'Criar ambiente',
    buildsOn: ({ machine }) => `Compila em ${machine}`,
    deploysFrom: ({ machine }) =>
      `As implementações correm a partir de ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Não mantém versões anteriores para reverter'
        : count === 1
          ? 'Mantém 1 versão anterior para reverter'
          : `Mantém ${count} versões anteriores para reverter`,
    fromExplicit: 'Escolhido por ti',
    fromProject: 'Do projeto',
    fromAccount: 'Da tua conta',
    fromBuiltin: 'Predefinição do Happier',
  },
  ru: {
    title: 'Как развёртывается',
    description:
      'Проверьте их перед созданием.',
    create: 'Создать окружение',
    buildsOn: ({ machine }) => `Собирается на ${machine}`,
    deploysFrom: ({ machine }) => `Развёртывания идут с ${machine}`,
    keepsPrevious: ({ count }) =>
      count === 0
        ? 'Не хранит прошлых версий для отката'
        : `Хранит прошлых версий для отката: ${count}`,
    fromExplicit: 'Выбрано вами',
    fromProject: 'Из проекта',
    fromAccount: 'Из вашего аккаунта',
    fromBuiltin: 'По умолчанию в Happier',
  },
  'zh-Hans': {
    title: '部署方式',
    description: '创建前请先确认。',
    create: '创建环境',
    buildsOn: ({ machine }) => `在 ${machine} 上构建`,
    deploysFrom: ({ machine }) => `从 ${machine} 运行部署`,
    keepsPrevious: ({ count }) =>
      count === 0 ? '不保留用于回滚的旧版本' : `保留 ${count} 个旧版本用于回滚`,
    fromExplicit: '你的选择',
    fromProject: '来自项目',
    fromAccount: '来自你的账户',
    fromBuiltin: 'Happier 默认值',
  },
  'zh-Hant': {
    title: '部署方式',
    description: '建立前請先確認。',
    create: '建立環境',
    buildsOn: ({ machine }) => `在 ${machine} 上建置`,
    deploysFrom: ({ machine }) => `從 ${machine} 執行部署`,
    keepsPrevious: ({ count }) =>
      count === 0 ? '不保留用於回復的舊版本' : `保留 ${count} 個舊版本以便回復`,
    fromExplicit: '你的選擇',
    fromProject: '來自專案',
    fromAccount: '來自你的帳戶',
    fromBuiltin: 'Happier 預設值',
  },
} satisfies Record<SupportedLanguage, DeploymentCreationReviewCopy>;
